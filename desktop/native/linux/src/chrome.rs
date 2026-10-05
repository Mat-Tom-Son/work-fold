use serde_json::{json, Value};
use std::{
    env,
    io::{self, Read, Write},
    process::{Command, Stdio},
    time::Duration,
};
use work_fold_linux_hosts::private_json;

const DISTRIBUTION: &str = include_str!("../../../../src/shared/chrome-distribution.json");
fn status(state: &str) -> Value {
    json!({"version":1,"state":"status","status":{"state":state,"checkedAt":chrono::Utc::now().to_rfc3339()}})
}
fn connect() -> Option<Value> {
    let distribution: Value = serde_json::from_str(DISTRIBUTION).ok()?;
    let store = distribution["storeId"].as_str()?;
    if store.len() != 32 || !store.bytes().all(|b| (b'a'..=b'p').contains(&b)) {
        return Some(status("store_unavailable"));
    }
    let origin = format!("chrome-extension://{store}/");
    let argv: Vec<_> = env::args().collect();
    if argv.len() != 2 || argv[1] != origin {
        return None;
    }
    let mut header = [0u8; 4];
    let mut input = io::stdin().lock();
    input.read_exact(&mut header).ok()?;
    let count = u32::from_le_bytes(header) as usize;
    if count == 0 || count > 16 * 1024 {
        return None;
    }
    let mut bytes = vec![0; count];
    input.read_exact(&mut bytes).ok()?;
    let request: Value = serde_json::from_slice(&bytes).ok()?;
    let binary = env::current_exe().ok()?;
    let root = binary.parent()?;
    if request["version"] == 1 && request["action"] == "open-app" {
        let receipt = private_json(&root.join("registration.json"), 16 * 1024).ok()?;
        if receipt["binary"].as_str()? != binary.to_str()? {
            return None;
        }
        let app = receipt["appPath"].as_str()?;
        if !std::path::Path::new(app).is_absolute() {
            return None;
        }
        return Some(status(
            if Command::new(app)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .env_remove("ELECTRON_RUN_AS_NODE")
                .spawn()
                .is_ok()
            {
                "connecting"
            } else {
                "app_not_running"
            },
        ));
    }
    let descriptor = match private_json(&root.join("launch.json"), 16 * 1024) {
        Ok(value) => value,
        Err(_) => return Some(status("app_not_running")),
    };
    let endpoint = descriptor["endpoint"].as_str()?;
    let port = endpoint
        .strip_prefix("http://127.0.0.1:")?
        .strip_suffix("/bootstrap")?;
    if port.is_empty()
        || !port.bytes().all(|b| b.is_ascii_digit())
        || port.parse::<u16>().ok()? == 0
    {
        return None;
    }
    let launch = descriptor["launchId"].as_str()?;
    uuid::Uuid::parse_str(launch).ok()?;
    let token = descriptor["bootstrapToken"].as_str()?;
    if descriptor["version"] != 1
        || token.len() != 64
        || !token
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return None;
    }
    let envelope =
        json!({"version":1,"launchId":launch,"extensionOrigin":origin,"request":request});
    // This host only speaks to the exact local endpoint. Never use a proxy,
    // follow redirects, or forward the launch bearer to any other destination.
    let agent = ureq::AgentBuilder::new()
        .redirects(0)
        .try_proxy_from_env(false)
        .timeout(Duration::from_secs(5))
        .build();
    let response = agent
        .post(endpoint)
        .set("Content-Type", "application/json")
        .set("Authorization", &format!("Bearer {token}"))
        .send_string(&envelope.to_string())
        .ok()?;
    if response.status() != 200 {
        return None;
    }
    let mut bytes = Vec::new();
    response
        .into_reader()
        .take(65537)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() > 65536 {
        return None;
    }
    let response: Value = serde_json::from_slice(&bytes).ok()?;
    if response["version"] != 1 {
        return None;
    }
    Some(response)
}
fn main() {
    // A truncated native-messaging frame cannot leave an orphan indefinitely.
    unsafe {
        libc::alarm(10);
    }
    let value = connect().unwrap_or_else(|| status("connection_error"));
    if let Ok(bytes) = serde_json::to_vec(&value) {
        if bytes.len() <= 65536 {
            let mut out = io::stdout().lock();
            let _ = out.write_all(&(bytes.len() as u32).to_le_bytes());
            let _ = out.write_all(&bytes);
            let _ = out.flush();
        }
    }
}
