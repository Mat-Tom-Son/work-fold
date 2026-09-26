use serde_json::{json, Value};
use std::{
    env, fs,
    io::{self, Read, Write},
    path::PathBuf,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};
use work_fold_linux_hosts::{atomic_json, environment, private_directory, private_json};

type Result<T> = std::result::Result<T, (i32, String)>;
fn error(value: impl std::fmt::Display) -> (i32, String) {
    (1, value.to_string())
}
fn usage(value: impl Into<String>) -> (i32, String) {
    (2, value.into())
}
struct Client {
    root: PathBuf,
    app: PathBuf,
    timeout: Duration,
}
struct Outcome {
    code: i32,
    stdout: String,
    stderr: String,
}
impl Outcome {
    fn emit(&self) {
        let _ = io::stdout().write_all(self.stdout.as_bytes());
        let _ = io::stderr().write_all(self.stderr.as_bytes());
    }
}
fn is_act(argv: &[String]) -> bool {
    let tokens: Vec<_> = argv
        .iter()
        .filter(|arg| arg.as_str() != "--json")
        .map(String::as_str)
        .collect();
    match tokens.first().copied().unwrap_or("") {
        "chat" | "chats" | "files" | "manage" | "history" | "search" | "library" | "tools"
        | "apps" | "routings" | "pages" | "trash" | "requests" => true,
        "checks" => tokens.get(1) != Some(&"status"),
        "spaces" => tokens.get(1) != Some(&"list"),
        _ => false,
    }
}
impl Client {
    fn request(
        &self,
        argv: &[String],
        token: Option<&str>,
        payload: Option<Value>,
    ) -> Result<Outcome> {
        let id = uuid::Uuid::new_v4().to_string();
        let request_path = self.root.join("requests").join(format!("{id}.json"));
        let response_path = self.root.join("responses").join(format!("{id}.json"));
        let result = (|| {
            let mut request = json!({"protocolVersion": if token.is_some() {3} else {1}, "id":id, "argv":argv,
                "cwd":env::current_dir().map_err(error)?, "createdAt":chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)});
            if let Some(token) = token {
                request["lane"] = json!("act");
                request["actToken"] = json!(token);
            }
            if let Some(payload) = payload {
                request["payload"] = payload;
            }
            let limit = if token.is_some() {
                2 * 1024 * 1024
            } else {
                128 * 1024
            };
            if serde_json::to_vec(&request).map_err(error)?.len() > limit {
                return Err(usage(format!("CLI request exceeds {limit} bytes.")));
            }
            atomic_json(&request_path, &request).map_err(error)?;
            let mut child = Command::new(&self.app)
                .args(["--work-fold-cli-request", &id])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .env_remove("ELECTRON_RUN_AS_NODE")
                .spawn()
                .map_err(error)?;
            // Reap second-instance launchers without waiting for the interactive host.
            thread::spawn(move || {
                let _ = child.wait();
            });
            let deadline = Instant::now() + self.timeout;
            loop {
                match private_json(&response_path, 2 * 1024 * 1024) {
                    Ok(response) => {
                        if response["protocolVersion"] != 1 || response["id"] != id {
                            return Err(error("Invalid CLI response identity or version"));
                        }
                        let code = response["exitCode"]
                            .as_i64()
                            .filter(|n| (0..=255).contains(n))
                            .ok_or_else(|| error("Invalid CLI exit code"))?
                            as i32;
                        return Ok(Outcome {
                            code,
                            stdout: response["stdout"].as_str().unwrap_or("").into(),
                            stderr: response["stderr"].as_str().unwrap_or("").into(),
                        });
                    }
                    Err(err) if err.kind() == io::ErrorKind::NotFound => {}
                    Err(err) => return Err(error(err)),
                }
                if Instant::now() >= deadline {
                    return Err((
                        124,
                        format!(
                            "work-fold did not answer CLI request {id} within {} ms.",
                            self.timeout.as_millis()
                        ),
                    ));
                }
                thread::sleep(Duration::from_millis(50));
            }
        })();
        let _ = fs::remove_file(request_path);
        let _ = fs::remove_file(response_path);
        result
    }
}
fn prepare(argv: Vec<String>) -> Result<(Vec<String>, Option<Value>)> {
    let mut out = Vec::new();
    let mut payload = None;
    let mut args = argv.into_iter();
    while let Some(arg) = args.next() {
        if arg != "--message-file" {
            out.push(arg);
            continue;
        }
        if payload.is_some() {
            return Err(usage("--message-file may be provided only once."));
        }
        let path = args
            .next()
            .ok_or_else(|| usage("--message-file requires a path."))?;
        let file = fs::File::open(path).map_err(error)?;
        if !file.metadata().map_err(error)?.is_file() {
            return Err(usage("--message-file must name a regular file."));
        }
        let mut bytes = Vec::new();
        file.take(262145).read_to_end(&mut bytes).map_err(error)?;
        if bytes.len() > 262144 {
            return Err(usage("--message-file exceeds 262144 bytes."));
        }
        let text = String::from_utf8(bytes).map_err(|_| usage("--message-file must be UTF-8."))?;
        payload = Some(json!({"messageFile":text}));
        out.push("--message-from-payload".into());
    }
    Ok((out, payload))
}
fn wait(client: &Client, argv: &[String], token: &str) -> Result<Option<Outcome>> {
    let tokens: Vec<_> = argv.iter().filter(|a| a.as_str() != "--json").collect();
    let group = tokens.first().map(|s| s.as_str()).unwrap_or("");
    if !["chat", "manage", "checks"].contains(&group)
        || tokens.get(1).map(|s| s.as_str()) != Some("wait")
    {
        return Ok(None);
    }
    let mut space = None;
    let mut task = None;
    let mut seconds = 600;
    let mut index = 2;
    while index < tokens.len() {
        let option = tokens[index].as_str();
        let value = tokens
            .get(index + 1)
            .ok_or_else(|| usage(format!("{option} requires a value.")))?;
        match option {
            "--space" if space.is_none() => space = Some((*value).clone()),
            "--task" if task.is_none() => task = Some((*value).clone()),
            "--timeout" => {
                seconds = value
                    .parse::<u64>()
                    .ok()
                    .filter(|s| (1..=3600).contains(s))
                    .ok_or_else(|| usage("--timeout must be between 1 and 3600 seconds."))?
            }
            _ => {
                return Err(usage(format!(
                    "Unknown or repeated option for {group} wait: {option}"
                )))
            }
        }
        index += 2;
    }
    if group == "manage" && space.is_some() {
        return Err(usage("The management scope does not take --space."));
    }
    if group != "manage" && space.is_none() {
        return Err(usage(
            "Act commands require an explicit --space <id-or-name>.",
        ));
    }
    let task = task.ok_or_else(|| usage("Provide --task <id>."))?;
    let mut scope = Vec::new();
    if let Some(space) = space {
        scope.extend(["--space".into(), space]);
    }
    scope.extend(["--task".into(), task]);
    let json_output = argv.iter().any(|s| s == "--json");
    let mut status = vec![
        group.into(),
        if group == "checks" {
            "task".into()
        } else {
            "status".into()
        },
    ];
    status.extend(scope.clone());
    status.push("--json".into());
    let deadline = Instant::now() + Duration::from_secs(seconds);
    loop {
        let result = client.request(&status, Some(token), None)?;
        if result.code != 0 {
            return Ok(Some(result));
        }
        let value: Value = serde_json::from_str(&result.stdout).map_err(error)?;
        let data = &value["data"];
        let state = data["task"]["state"]
            .as_str()
            .ok_or_else(|| error("Unreadable task status"))?;
        let request_state = data["requestGraph"]["state"]
            .as_str()
            .or(data["request"]["state"].as_str());
        if !data["waiting"].is_null() || request_state == Some("waiting") {
            if json_output {
                return Ok(Some(result));
            }
            status.pop();
            return client.request(&status, Some(token), None).map(Some);
        }
        let running = request_state
            .map(|s| ["working", "handed_off"].contains(&s))
            .unwrap_or(["accepted", "running"].contains(&state));
        if !running {
            break;
        }
        if Instant::now() >= deadline {
            return Err((7, format!("{group} wait timed out after {seconds}s.")));
        }
        thread::sleep(Duration::from_secs(2));
    }
    let mut result = vec![group.into(), "result".into()];
    result.extend(scope);
    if json_output {
        result.push("--json".into());
    }
    client.request(&result, Some(token), None).map(Some)
}
fn run() -> Result<Outcome> {
    let argv: Vec<_> = env::args().skip(1).collect();
    let executable = env::current_exe().map_err(error)?;
    let app = environment("WORKFOLD_CLI_APP")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            executable
                .parent()
                .unwrap()
                .parent()
                .unwrap()
                .join("work-fold-desktop")
        });
    let base = environment("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| environment("HOME").map(|home| PathBuf::from(home).join(".config")))
        .ok_or_else(|| error("HOME or XDG_CONFIG_HOME is required"))?;
    let root = environment("WORKFOLD_CLI_STATE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| base.join("work-fold"))
        .join("cli");
    let timeout = environment("WORKFOLD_CLI_TIMEOUT_MS")
        .unwrap_or_else(|| "120000".into())
        .parse::<u64>()
        .ok()
        .filter(|n| (100..=600000).contains(n))
        .ok_or_else(|| usage("WORKFOLD_CLI_TIMEOUT_MS must be between 100 and 600000."))?;
    private_directory(&root).map_err(error)?;
    private_directory(&root.join("requests")).map_err(error)?;
    private_directory(&root.join("responses")).map_err(error)?;
    let client = Client {
        root,
        app,
        timeout: Duration::from_millis(timeout),
    };
    if is_act(&argv) {
        let token = private_json(&client.root.join("act-token.json"), 4096).ok()
            .filter(|record| record["version"] == 1).and_then(|record| record["actToken"].as_str().map(str::to_owned))
            .filter(|s| (16..=256).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'))
            .ok_or_else(|| (6, "Open work-fold to run this command. Act commands need the work-fold app running.".into()))?;
        if let Some(result) = wait(&client, &argv, &token)? {
            return Ok(result);
        }
        let (argv, payload) = prepare(argv)?;
        client.request(&argv, Some(&token), payload)
    } else {
        client.request(&argv, None, None)
    }
}
fn main() {
    match run() {
        Ok(outcome) => {
            outcome.emit();
            std::process::exit(outcome.code);
        }
        Err((code, message)) => {
            eprintln!("work-fold: {message}");
            std::process::exit(code);
        }
    }
}
