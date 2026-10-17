//! Private stdio transport owned by the desktop host. Starting sharing is a
//! trusted setup operation; model-facing calls use an already-granted target.
use anyhow::{anyhow, ensure, Context, Result};
use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{path::PathBuf, time::Duration};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use uuid::Uuid;
use work_fold_wayland::{capture::Frame, ei::Region, portal::SharedScreen, seat::SeatLease};

const MAX_COMMAND: u64 = 64 * 1024;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request { id: String, command: Command }
#[derive(Deserialize)]
#[serde(tag = "method", rename_all = "snake_case", deny_unknown_fields)]
enum Command {
    Start,
    Status,
    Begin { turn: String },
    End { lease: String },
    Observe { lease: String },
    Act { lease: String, observation: String, actions: Vec<Action> },
    Close,
}
#[derive(Deserialize, Clone, Copy)]
#[serde(deny_unknown_fields)]
struct Point { x: f64, y: f64 }
#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
enum Action {
    Click { x: f64, y: f64, #[serde(default)] button: Button, #[serde(default = "one")] count: u8 },
    TypeText { text: String },
    Keypress { keys: Vec<String> },
    Scroll { x: f64, y: f64, #[serde(rename = "scrollX")] dx: f64, #[serde(rename = "scrollY")] dy: f64 },
    MoveMouse { x: f64, y: f64 },
    Drag { path: Vec<Point> },
}
#[derive(Deserialize, Default)]
#[serde(rename_all = "lowercase")]
enum Button { #[default] Left, Right, Middle }
fn one() -> u8 { 1 }
impl Button { fn code(&self) -> u32 { match self { Self::Left => 272, Self::Right => 273, Self::Middle => 274 } } }

struct Lease { id: String, _turn: String, _seat: SeatLease }
struct Observation { id: String, width: u32, height: u32, mapping: Option<String>, regions: Vec<Region> }
struct Host {
    target: String,
    screen: Option<SharedScreen>,
    lease: Option<Lease>,
    observation: Option<Observation>,
    stopped: tokio::sync::watch::Receiver<bool>,
}
impl Host {
    fn new(stopped: tokio::sync::watch::Receiver<bool>) -> Self { Self { target: Uuid::new_v4().to_string(), screen: None, lease: None, observation: None, stopped } }
    fn check_lease(&self, lease: &str) -> Result<()> {
        ensure!(self.lease.as_ref().is_some_and(|current| current.id == lease), "This accepted turn does not own the shared desktop");
        Ok(())
    }
    fn screen(&mut self) -> Result<&mut SharedScreen> {
        let screen = self.screen.as_mut().context("Start desktop sharing in work-fold setup")?;
        screen.check()?;
        Ok(screen)
    }
    async fn observe(&mut self, lease: &str) -> Result<Value> {
        self.check_lease(lease)?;
        let screen = self.screen()?;
        let frame = screen.frame().await?;
        let mapping = screen.input_mapping(&frame).ok().map(str::to_owned);
        let regions = match screen.input.as_ref() { Some(input) => input.regions()?, None => vec![] };
        let observation = Observation { id: Uuid::new_v4().to_string(), width: frame.info.width,
            height: frame.info.height, mapping, regions };
        let result = json!({ "targetId": self.target, "observationId": observation.id,
            "kind": "shared_screen", "frame": frame.info, "inputAvailable": observation.mapping.is_some(),
            "image": { "mimeType": "image/png", "data": base64::engine::general_purpose::STANDARD.encode(frame.png()?) } });
        self.observation = Some(observation);
        Ok(result)
    }
    async fn act(&mut self, lease: &str, id: &str, actions: &[Action]) -> Result<Value> {
        self.check_lease(lease)?;
        ensure!((1..=20).contains(&actions.len()), "Use 1 to 20 actions");
        ensure!(self.observation.as_ref().is_some_and(|old| old.id == id), "Observation is stale; observe the shared screen again");
        // Once admitted, an action attempt consumes its observation even if an
        // error follows. Neither uncertain effects nor commands are replayed.
        let old = self.observation.take().unwrap();
        let screen = self.screen()?;
        let frame = screen.frame().await?;
        let mapping = screen.input_mapping(&frame)?.to_owned();
        let (scale_x, scale_y) = screen.input_scale(&frame)?;
        ensure!(old.width == frame.info.width && old.height == frame.info.height
            && old.mapping.as_deref() == Some(mapping.as_str()), "Shared-screen geometry changed; observe again");
        let input = screen.input.as_mut().context("Input permission is unavailable")?;
        ensure!(input.regions()? == old.regions, "Input mapping changed; observe again");
        for action in actions { validate(action, &frame, input)?; }
        for action in actions {
            // Every pointer method also rechecks its pinned EI device. Keys
            // and buttons are paired, including cancellation of a drag.
            match action {
                Action::Click { x, y, button, count } => {
                    input.move_absolute(&mapping, x * scale_x, y * scale_y)?;
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    input.click(&mapping, x * scale_x, y * scale_y, button.code(), *count)?;
                }
                Action::TypeText { text } => input.type_text(text)?,
                Action::Keypress { keys } => input.shortcut(keys)?,
                Action::Scroll { x, y, dx, dy } => input.scroll(&mapping, x * scale_x, y * scale_y, *dx, *dy)?,
                Action::MoveMouse { x, y } => input.move_absolute(&mapping, x * scale_x, y * scale_y)?,
                Action::Drag { path } => input.drag(&mapping, &path.iter().map(|p| (p.x * scale_x, p.y * scale_y)).collect::<Vec<_>>()).await?,
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
            input.dispatch()?;
        }
        // Effects are reported as sent; the successor image lets the normal
        // Pi tool loop judge the application's outcome without inventing proof.
        let mut result = self.observe(lease).await?;
        result["inputSent"] = json!(true);
        result["actionCount"] = json!(actions.len());
        Ok(result)
    }
    async fn command(&mut self, command: Command) -> Result<Value> {
        match command {
            Command::Start => {
                ensure!(self.screen.is_none(), "A sharing session already exists");
                let mut stopped = self.stopped.clone();
                self.screen = Some(SharedScreen::request(async move {
                    if !*stopped.borrow() { let _ = stopped.changed().await; }
                }).await?);
                self.status()
            }
            Command::Status => self.status(),
            Command::Begin { turn } => {
                ensure!(!turn.is_empty() && turn.len() <= 160 && turn.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b)), "Invalid accepted-turn identity");
                self.screen()?;
                ensure!(self.lease.is_none(), "A turn already owns this sharing session");
                let runtime = PathBuf::from(std::env::var_os("XDG_RUNTIME_DIR").context("Missing desktop runtime directory")?);
                let seat = SeatLease::acquire(&runtime)?;
                if let Some(input) = self.screen()?.input.as_mut() { input.begin_sequence()?; }
                let id = Uuid::new_v4().to_string();
                self.lease = Some(Lease { id: id.clone(), _turn: turn, _seat: seat });
                Ok(json!({ "lease": id, "targetId": self.target }))
            }
            Command::End { lease } => {
                self.check_lease(&lease)?;
                if let Some(input) = self.screen()?.input.as_mut() { input.end_sequence(); }
                self.observation = None; self.lease = None;
                Ok(json!({ "released": true }))
            }
            Command::Observe { lease } => self.observe(&lease).await,
            Command::Act { lease, observation, actions } => self.act(&lease, &observation, &actions).await,
            Command::Close => { self.close().await?; Ok(json!({ "closed": true })) }
        }
    }
    fn status(&mut self) -> Result<Value> {
        let target = self.target.clone();
        let active = self.lease.is_some();
        let screen = self.screen()?;
        Ok(json!({ "state": "active", "targetId": target, "kind": "shared_screen",
            "devicesGranted": screen.devices, "controlInUse": active, "logicalSize": screen.logical_size }))
    }
    async fn close(&mut self) -> Result<()> {
        self.observation = None;
        // Keep the OS seat lock until the native session has actually closed.
        let result = match self.screen.take() { Some(mut screen) => screen.close().await, None => Ok(()) };
        self.lease = None;
        result
    }
}

fn validate(action: &Action, frame: &Frame, input: &work_fold_wayland::ei::Sender) -> Result<()> {
    let point = |x: f64, y: f64| -> Result<()> {
        ensure!(x.is_finite() && y.is_finite() && x >= 0.0 && y >= 0.0
            && x < f64::from(frame.info.width) && y < f64::from(frame.info.height), "Point lies outside the observed screen"); Ok(())
    };
    match action {
        Action::Click { x, y, count, .. } => { point(*x, *y)?; ensure!((1..=3).contains(count), "Invalid click count"); }
        Action::MoveMouse { x, y } => point(*x, *y)?,
        Action::Scroll { x, y, dx, dy } => { point(*x, *y)?; ensure!(dx.is_finite() && dy.is_finite()
            && dx.abs() <= 10_000.0 && dy.abs() <= 10_000.0 && (*dx != 0.0 || *dy != 0.0), "Invalid scroll delta"); }
        Action::TypeText { text } => input.validate_text(text)?,
        Action::Keypress { keys } => input.validate_shortcut(keys)?,
        Action::Drag { path } => { ensure!((2..=64).contains(&path.len()), "Invalid drag path"); for p in path { point(p.x, p.y)?; } }
    }
    Ok(())
}

async fn run() -> Result<()> {
    ensure!(std::env::args().skip(1).collect::<Vec<_>>() == ["--stdio"], "Use --stdio from the desktop host");
    // A crashed desktop must not leave its grant or pending chooser behind.
    // Check the parent again after installing Linux's parent-death signal.
    let parent = unsafe { libc::getppid() };
    ensure!(unsafe { libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM) } == 0, "Cannot bind helper lifetime to its host");
    ensure!(parent > 1 && unsafe { libc::getppid() } == parent, "Desktop host ended during helper startup");
    gstreamer::init()?;
    let mut input = BufReader::new(tokio::io::stdin());
    let mut output = tokio::io::stdout();
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    let (stop, mut stopped) = tokio::sync::watch::channel(false);
    let signal = tokio::spawn(async move {
        tokio::select! { _ = terminate.recv() => {}, _ = tokio::signal::ctrl_c() => {} }
        stop.send_replace(true);
    });
    let mut host = Host::new(stopped.clone());
    let mut seen = std::collections::HashSet::new();
    let result = async {
        loop {
            let mut line = Vec::new();
            let mut limited = (&mut input).take(MAX_COMMAND + 1);
            let mut revocation = host.screen.as_ref().map(SharedScreen::closed_signal);
            let bytes = tokio::select! {
                bytes = limited.read_until(b'\n', &mut line) => bytes?,
                _ = stopped.changed() => return Err(anyhow!("Desktop sharing stopped")),
                _ = revoked(&mut revocation) => return Err(anyhow!("Desktop sharing was revoked")),
            };
            if bytes == 0 { return Ok::<_, anyhow::Error>(()); }
            ensure!(bytes as u64 <= MAX_COMMAND && line.last() == Some(&b'\n'), "Invalid command framing");
            let request: Request = serde_json::from_slice(&line).context("Invalid helper command")?;
            ensure!(Uuid::parse_str(&request.id).is_ok(), "Invalid command identity");
            ensure!(seen.len() < 4096 && seen.insert(request.id.clone()), "Duplicate command or exhausted session; start sharing again");
            let closing = matches!(request.command, Command::Close);
            let starting = matches!(request.command, Command::Start);
            let result = if starting {
                // Start owns a provisional portal Session until it returns;
                // let its cancellation branch close that Session explicitly.
                host.command(request.command).await
            } else {
                tokio::select! {
                    result = host.command(request.command) => result,
                    _ = stopped.changed() => return Err(anyhow!("Desktop sharing stopped; input may have been delivered")),
                    _ = revoked(&mut revocation) => return Err(anyhow!("Desktop sharing was revoked; input may have been delivered")),
                }
            };
            ensure!(!*stopped.borrow(), "Desktop sharing stopped");
            let response = match result {
                Ok(value) => json!({ "version": 1, "id": request.id, "result": value }),
                Err(error) => json!({ "version": 1, "id": request.id, "error": error.to_string(), "retry": false }),
            };
            output.write_all(serde_json::to_string(&response)?.as_bytes()).await?;
            output.write_all(b"\n").await?; output.flush().await?;
            if closing { return Ok(()); }
        }
    };
    let result = result.await;
    let closed = host.close().await;
    signal.abort();
    result.and(closed)
}

async fn revoked(signal: &mut Option<tokio::sync::watch::Receiver<bool>>) {
    if let Some(signal) = signal {
        if !*signal.borrow() { let _ = signal.changed().await; }
    } else { std::future::pending::<()>().await; }
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    // The host must fence first, signal, then kill/reap independently if a
    // native media-library call does not unwind within its teardown deadline.
    let result = run().await;
    if let Err(error) = &result { eprintln!("{error}"); }
    std::process::exit(if result.is_ok() { 0 } else { 1 });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn commands_reject_unknown_fields_and_actions() {
        for json in [r#"{"id":"x","command":{"method":"observe","lease":"x","foreground":true}}"#,
            r#"{"id":"x","command":{"method":"act","lease":"x","observation":"x","actions":[{"action":"shell","command":"anything"}]}}"#] {
            assert!(serde_json::from_str::<Request>(json).is_err());
        }
        assert!(serde_json::from_str::<Request>(r#"{"id":"x","command":{"method":"status"}}"#).is_ok());
    }
}
