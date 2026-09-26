//! One explicitly selected monitor, with a shared capture/input session.
use crate::{capture::{Capture, Frame}, ei::Sender};
use anyhow::{anyhow, ensure, Context, Result};
use ashpd::desktop::{remote_desktop::{DeviceType, RemoteDesktop, SelectDevicesOptions},
    screencast::{CursorMode, Screencast, SelectSourcesOptions, SourceType}, PersistMode, Session};
use futures_util::StreamExt;
use std::{sync::Arc, time::Duration};
use tokio::sync::{oneshot, watch};

// GNOME and KDE expose the same typed methods/signals under separate names.
// The builder below selects only these two reviewed desktop contracts.
#[zbus::proxy(interface = "org.freedesktop.ScreenSaver")]
trait ScreenSaver {
    fn get_active(&self) -> zbus::Result<bool>;
    #[zbus(signal)]
    fn active_changed(&self, active: bool) -> zbus::Result<()>;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct LockService { name: &'static str, path: &'static str }
const GNOME_LOCK: LockService = LockService { name: "org.gnome.ScreenSaver", path: "/org/gnome/ScreenSaver" };
const KDE_LOCK: LockService = LockService { name: "org.freedesktop.ScreenSaver", path: "/ScreenSaver" };

fn lock_service(desktop: &str) -> Result<LockService> {
    let names: Vec<_> = desktop.split(':').collect();
    let gnome = names.iter().any(|name| name.eq_ignore_ascii_case("GNOME"));
    let kde = names.iter().any(|name| name.eq_ignore_ascii_case("KDE"));
    match (gnome, kde) {
        (true, false) => Ok(GNOME_LOCK),
        (false, true) => Ok(KDE_LOCK),
        _ => Err(anyhow!("Screen sharing requires an identifiable GNOME or KDE desktop session")),
    }
}

async fn monitor_screen_lock(connection: &zbus::Connection, service: LockService,
    ready: oneshot::Sender<Result<()>>) {
    let mut ready = Some(ready);
    let result = async {
        let proxy = ScreenSaverProxy::builder(connection).destination(service.name)?
            .path(service.path)?.interface(service.name)?.build().await?;
        // This first typed call may activate the desktop's lock proxy. Its
        // initial name acquisition is setup, not revocation. Recheck below
        // after both subscriptions; this lookup alone never grants sharing.
        ensure!(!proxy.get_active().await?, "Unlock the desktop before sharing a screen");
        // Subscribe before querying state. Loss/replacement of the original
        // service is revocation too; never silently follow a new lock service.
        let mut owners = proxy.inner().receive_owner_changed().await?;
        let mut changes = proxy.receive_active_changed().await?;
        ensure!(!proxy.get_active().await?, "Unlock the desktop before sharing a screen");
        let _ = ready.take().unwrap().send(Ok(()));
        loop {
            tokio::select! {
                _ = owners.next() => return Err(anyhow!("Desktop screen-lock service changed")),
                change = changes.next() => {
                    let change = change.context("Desktop screen-lock signal stream ended")?;
                    if change.args()?.active { return Ok::<_, anyhow::Error>(()); }
                }
            }
        }
    }.await;
    if let Some(ready) = ready { let _ = ready.send(result); }
    else if let Err(error) = result { eprintln!("Screen-lock monitoring ended: {error}"); }
}

pub struct SharedScreen {
    session: Arc<Session<RemoteDesktop>>,
    closed: watch::Receiver<bool>,
    watchers: Vec<tokio::task::JoinHandle<()>>,
    capture: Option<Capture>,
    pub input: Option<Sender>,
    pub mapping_id: Option<String>,
    pub logical_size: Option<(i32, i32)>,
    pub logical_position: Option<(i32, i32)>,
    pub devices: u32,
    alive: bool,
}

impl Drop for SharedScreen {
    fn drop(&mut self) { for watcher in &self.watchers { watcher.abort(); } }
}

impl SharedScreen {
    pub async fn request(cancel: impl std::future::Future<Output = ()>) -> Result<Self> {
        let lock_service = lock_service(&std::env::var("XDG_CURRENT_DESKTOP").unwrap_or_default())?;
        let remote = RemoteDesktop::new().await?;
        let cast = Screencast::with_connection(remote.connection().clone()).await?;
        let session = Arc::new(remote.create_session(Default::default()).await?);
        let watched = session.clone();
        let (closed_sender, closed) = watch::channel(false);
        let lock_sender = closed_sender.clone();
        let (subscribed, ready) = oneshot::channel();
        // ASHPD's signal stream borrows Session. A scoped watcher owns an Arc
        // and subscribes before Start; no self-reference or unsafe lifetime.
        let watcher = tokio::spawn(async move {
            let stream = match watched.receive_closed().await {
                Ok(stream) => { let _ = subscribed.send(Ok::<_, anyhow::Error>(())); stream }
                Err(error) => { let _ = subscribed.send(Err(error.into())); return; }
            };
            let mut stream = std::pin::pin!(stream);
            stream.next().await;
            closed_sender.send_replace(true);
        });
        ready.await.context("Portal watcher ended before subscription")??;
        let mut screen = Self { session, closed, watchers: vec![watcher], capture: None, input: None,
            mapping_id: None, logical_size: None, logical_position: None, devices: 0, alive: true };
        let connection = remote.connection().clone();
        let (lock_ready, lock_subscribed) = oneshot::channel();
        // Electron does not emit lock-screen on every Linux desktop. The
        // selected desktop's native session service is therefore mandatory.
        screen.watchers.push(tokio::spawn(async move {
            monitor_screen_lock(&connection, lock_service, lock_ready).await;
            lock_sender.send_replace(true);
        }));
        if let Err(error) = lock_subscribed.await.context("Screen-lock monitor ended").and_then(|r| r) {
            screen.close().await.ok();
            return Err(error.context("Desktop screen-lock monitoring is unavailable"));
        }
        let mut revoked = screen.closed.clone();
        let operation = async {
            remote.select_devices(&screen.session, SelectDevicesOptions::default()
                .set_devices(DeviceType::Keyboard | DeviceType::Pointer).set_persist_mode(PersistMode::DoNot)).await?.response()?;
            cast.select_sources(&screen.session, SelectSourcesOptions::default()
                // KDE's RemoteDesktop portal merges all monitors into one
                // workspace stream when multiple=false. Request individual
                // streams there so the one-monitor check below cannot admit
                // a combined desktop before any pixels reach the application.
                .set_sources(Some(SourceType::Monitor.into())).set_multiple(lock_service == KDE_LOCK)
                .set_cursor_mode(CursorMode::Embedded).set_persist_mode(PersistMode::DoNot)).await?.response()?;
            let selection = remote.start(&screen.session, None, Default::default()).await?.response()?;
            if lock_service == KDE_LOCK {
                ensure!(selection.streams().len() == 1,
                    "KDE screen sharing currently requires one connected monitor; stop sharing and use a single-monitor desktop");
            }
            ensure!(selection.streams().len() == 1, "Select exactly one monitor");
            let stream = &selection.streams()[0];
            screen.logical_size = stream.size();
            screen.logical_position = stream.position();
            screen.mapping_id = stream.mapping_id().map(str::to_owned);
            screen.devices = selection.devices().bits();
            let fd = cast.open_pipe_wire_remote(&screen.session, Default::default()).await?;
            screen.capture = Some(Capture::portal(fd.into(), stream.pipe_wire_node_id()).await?);
            // Never publish Active before a usable frame arrives.
            screen.capture.as_ref().unwrap().frame().await?;
            if remote.version() >= 2 && !selection.devices().is_empty() {
                let fd = remote.connect_to_eis(&screen.session, Default::default()).await?;
                screen.input = Some(Sender::new(fd.into())?);
                let sender = screen.input.as_mut().unwrap();
                tokio::time::timeout(Duration::from_secs(5), async {
                    loop {
                        sender.dispatch()?;
                        if sender.ready_for(selection.devices().contains(DeviceType::Pointer),
                            selection.devices().contains(DeviceType::Keyboard)) { return Ok::<_, anyhow::Error>(()); }
                        tokio::time::sleep(Duration::from_millis(10)).await;
                    }
                }).await.context("EIS negotiation timed out")??;
            }
            Ok::<_, anyhow::Error>(())
        };
        let result = tokio::select! {
            result = tokio::time::timeout(Duration::from_secs(60), operation) => result.context("Desktop chooser timed out").and_then(|r| r),
            _ = cancel => Err(anyhow!("Desktop sharing cancelled")),
            _ = revoked.changed() => Err(anyhow!("Desktop sharing was revoked")),
        };
        if let Err(error) = result {
            eprintln!("Portal session close: {}", if screen.close().await.is_ok() { "confirmed" } else { "unconfirmed" });
            return Err(error);
        }
        screen.check()?;
        Ok(screen)
    }

    pub fn closed_signal(&self) -> watch::Receiver<bool> { self.closed.clone() }

    /// Pump transport events before every observation and action. Revocation
    /// invalidates this object; callers must never turn it into an auto-retry.
    pub fn check(&mut self) -> Result<()> {
        if *self.closed.borrow() || self.closed.has_changed().is_err() { self.alive = false; }
        ensure!(self.alive, "Desktop sharing ended; start a new sharing session");
        if let Some(input) = self.input.as_mut() {
            if let Err(error) = input.dispatch() { self.alive = false; return Err(error); }
        }
        Ok(())
    }

    pub async fn frame(&mut self) -> Result<Frame> {
        self.check()?;
        let frame = self.capture.as_ref().context("No capture stream")?.frame().await?;
        self.check()?;
        Ok(frame)
    }

    /// Match the granted stream to exactly one logical input region. Pixels
    /// and input coordinates differ on scaled displays; the compositor owns
    /// both geometries and its mapping id is the association between them.
    pub fn input_mapping(&self, frame: &Frame) -> Result<&str> {
        ensure!(self.alive && self.devices & 3 == 3, "Pointer and keyboard permission are required");
        let mapping = self.mapping_id.as_deref().context("The portal supplied no input mapping")?;
        let input = self.input.as_ref().context("No EIS input connection")?;
        let regions: Vec<_> = input.regions()?.into_iter().filter(|r| r.mapping_id.as_deref() == Some(mapping)).collect();
        ensure!(regions.len() == 1, "The shared monitor has no unique input geometry");
        let region = &regions[0];
        ensure!(self.logical_size == Some((region.width as i32, region.height as i32)), "Portal and input geometry disagree");
        coordinate_scale(frame.info.width, frame.info.height, region)?;
        Ok(mapping)
    }

    pub fn input_scale(&self, frame: &Frame) -> Result<(f64, f64)> {
        let mapping = self.input_mapping(frame)?;
        let region = self.input.as_ref().unwrap().regions()?.into_iter()
            .find(|region| region.mapping_id.as_deref() == Some(mapping)).context("Input region disappeared")?;
        coordinate_scale(frame.info.width, frame.info.height, &region)
    }

    pub async fn close(&mut self) -> Result<()> {
        self.alive = false;
        self.input.take();
        // Revoke the PipeWire remote first, so a blocked native transition can
        // unwind. Pipeline teardown has a separate host kill-and-reap deadline.
        let closed = tokio::time::timeout(Duration::from_secs(3), self.session.close()).await;
        let confirmed = matches!(closed, Ok(Ok(()))) || *self.closed.borrow()
            || (tokio::time::timeout(Duration::from_millis(250), self.closed.changed()).await.is_ok() && *self.closed.borrow());
        if let Some(capture) = self.capture.take() {
            let drop_task = tokio::task::spawn_blocking(move || drop(capture));
            tokio::time::timeout(Duration::from_secs(2), drop_task).await.context("Media teardown timed out")??;
        }
        ensure!(confirmed, "Portal close was not confirmed");
        Ok(())
    }
}

fn coordinate_scale(width: u32, height: u32, region: &crate::ei::Region) -> Result<(f64, f64)> {
    ensure!(width > 0 && height > 0 && region.width > 0 && region.height > 0
        && region.physical_scale.is_finite() && region.physical_scale >= 1.0 && region.physical_scale <= 4.0,
        "Invalid shared-screen geometry");
    // Fractional logical dimensions may be rounded by the compositor. Admit
    // only the tiny rounding error, never an arbitrary crop or aspect ratio.
    ensure!((f64::from(width) - f64::from(region.width) * region.physical_scale).abs() <= 2.0
        && (f64::from(height) - f64::from(region.height) * region.physical_scale).abs() <= 2.0,
        "Captured pixels do not match the input region");
    Ok((f64::from(region.width) / f64::from(width), f64::from(region.height) / f64::from(height)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::{BufRead, Write}, process::{Child, Command, Stdio}, sync::atomic::{AtomicBool, Ordering}};

    // No desktop activation directories are loaded. The optional private
    // directory starts only this test binary's synthetic lock service.
    struct TestBus {
        child: Child, address: String, _config: tempfile::NamedTempFile,
        _services: Option<tempfile::TempDir>,
        _stdout: std::io::BufReader<std::process::ChildStdout>,
    }
    impl TestBus {
        fn new() -> Self { Self::with_activation(false) }
        fn with_activation(activate: bool) -> Self {
            let services = activate.then(|| tempfile::tempdir().unwrap());
            let service_config = if let Some(directory) = &services {
                let executable = std::env::current_exe().unwrap();
                let executable = executable.to_str().unwrap().replace('\\', "\\\\").replace('"', "\\\"");
                for service in [GNOME_LOCK, KDE_LOCK] {
                    std::fs::write(directory.path().join(format!("{}.service", service.name)),
                        format!("[D-BUS Service]\nName={}\nExec=\"{executable}\" --exact portal::tests::activated_lock_service_process --ignored --nocapture\n", service.name)).unwrap();
                }
                format!("<servicedir>{}</servicedir>", directory.path().display())
            } else { String::new() };
            let mut config = tempfile::NamedTempFile::new().unwrap();
            write!(config, "<busconfig><type>session</type><listen>unix:tmpdir=/tmp</listen><auth>EXTERNAL</auth>{service_config}<policy context=\"default\"><allow send_destination=\"*\"/><allow receive_sender=\"*\"/><allow own=\"*\"/></policy></busconfig>").unwrap();
            let mut child = Command::new("dbus-daemon").arg(format!("--config-file={}", config.path().display()))
                .args(["--nofork", "--nopidfile", "--print-address=1"])
                .stdin(Stdio::null()).stdout(Stdio::piped()).spawn().unwrap();
            let stdout = std::io::BufReader::new(child.stdout.take().unwrap());
            let mut bus = Self { child, address: String::new(), _config: config, _services: services, _stdout: stdout };
            bus._stdout.read_line(&mut bus.address).unwrap();
            bus.address = bus.address.trim().to_owned();
            assert!(bus.address.starts_with("unix:"));
            bus
        }
        async fn connection(&self) -> zbus::Connection {
            zbus::connection::Builder::address(self.address.as_str()).unwrap().build().await.unwrap()
        }
        async fn serve(&self, service: LockService, active: bool) -> zbus::Connection {
            let state = Arc::new(AtomicBool::new(active));
            let builder = zbus::connection::Builder::address(self.address.as_str()).unwrap().name(service.name).unwrap();
            if service == GNOME_LOCK { builder.serve_at(service.path, GnomeLock(state)).unwrap().build().await.unwrap() }
            else { builder.serve_at(service.path, KdeLock(state)).unwrap().build().await.unwrap() }
        }
    }
    impl Drop for TestBus {
        fn drop(&mut self) {
            self.child.kill().ok(); self.child.wait().ok();
            // The activation subprocess exits when this bus closes. Drain its
            // test-runner output before closing the pipe beneath it.
            std::io::copy(&mut self._stdout, &mut std::io::sink()).ok();
        }
    }
    struct GnomeLock(Arc<AtomicBool>);
    #[zbus::interface(name = "org.gnome.ScreenSaver")]
    impl GnomeLock {
        fn get_active(&self) -> bool { self.0.load(Ordering::SeqCst) }
    }
    struct KdeLock(Arc<AtomicBool>);
    #[zbus::interface(name = "org.freedesktop.ScreenSaver")]
    impl KdeLock {
        fn get_active(&self) -> bool { self.0.load(Ordering::SeqCst) }
    }
    // Launched only by the private bus's generated activation files. It never
    // selects the person's session bus and exits when that private bus closes.
    #[tokio::test]
    #[ignore = "Private D-Bus activation subprocess; exercised by cold_lock_service_activation_is_not_revocation"]
    async fn activated_lock_service_process() {
        let address = std::env::var("DBUS_STARTER_ADDRESS").unwrap();
        assert!(address.starts_with("unix:"));
        let connection = zbus::connection::Builder::address(address.as_str()).unwrap()
            .name(GNOME_LOCK.name).unwrap().name(KDE_LOCK.name).unwrap()
            .serve_at(GNOME_LOCK.path, GnomeLock(Arc::new(AtomicBool::new(false)))).unwrap()
            .serve_at(KDE_LOCK.path, KdeLock(Arc::new(AtomicBool::new(false)))).unwrap()
            .build().await.unwrap();
        let mut messages = zbus::MessageStream::from(&connection);
        while let Some(Ok(_)) = messages.next().await {}
    }
    async fn monitor(bus: &TestBus, service: LockService) -> (oneshot::Receiver<Result<()>>, tokio::task::JoinHandle<()>) {
        let connection = bus.connection().await;
        let (send, receive) = oneshot::channel();
        (receive, tokio::spawn(async move { monitor_screen_lock(&connection, service, send).await }))
    }
    #[test]
    fn only_identifiable_supported_desktops_choose_a_lock_service() {
        for desktop in ["GNOME", "ubuntu:GNOME", "gnome"] { assert_eq!(lock_service(desktop).unwrap(), GNOME_LOCK); }
        for desktop in ["KDE", "plasma:KDE", "kde"] { assert_eq!(lock_service(desktop).unwrap(), KDE_LOCK); }
        for desktop in ["", "GNOME:KDE", "not-GNOME", "XFCE", "KDE-other"] { assert!(lock_service(desktop).is_err()); }
    }
    #[tokio::test]
    async fn both_native_lock_interfaces_revoke_on_active_signal() {
        for service in [GNOME_LOCK, KDE_LOCK] {
            let bus = TestBus::new();
            let server = bus.serve(service, false).await;
            let (ready, mut task) = monitor(&bus, service).await;
            tokio::time::timeout(Duration::from_secs(3), ready).await.unwrap().unwrap().unwrap();
            server.emit_signal(None::<&str>, service.path, service.name, "ActiveChanged", &(false,)).await.unwrap();
            assert!(tokio::time::timeout(Duration::from_millis(30), &mut task).await.is_err());
            server.emit_signal(None::<&str>, service.path, service.name, "ActiveChanged", &(true,)).await.unwrap();
            tokio::time::timeout(Duration::from_secs(3), task).await.unwrap().unwrap();
        }
    }
    #[tokio::test]
    async fn locked_or_missing_services_never_publish_readiness() {
        for service in [GNOME_LOCK, KDE_LOCK] {
            let bus = TestBus::new();
            let server = bus.serve(service, true).await;
            let (ready, task) = monitor(&bus, service).await;
            let error = tokio::time::timeout(Duration::from_secs(3), ready).await.unwrap().unwrap().unwrap_err();
            assert!(error.to_string().contains("Unlock the desktop"));
            task.await.unwrap();
            server.release_name(service.name).await.unwrap();
            let (ready, task) = monitor(&bus, service).await;
            assert!(tokio::time::timeout(Duration::from_secs(3), ready).await.unwrap().unwrap().is_err());
            task.await.unwrap();
        }
    }
    #[tokio::test]
    async fn losing_the_lock_service_revokes_an_unlocked_session() {
        for service in [GNOME_LOCK, KDE_LOCK] {
            let bus = TestBus::new();
            let server = bus.serve(service, false).await;
            let (ready, task) = monitor(&bus, service).await;
            tokio::time::timeout(Duration::from_secs(3), ready).await.unwrap().unwrap().unwrap();
            server.release_name(service.name).await.unwrap();
            tokio::time::timeout(Duration::from_secs(3), task).await.unwrap().unwrap();
        }
    }
    #[tokio::test]
    async fn cold_lock_service_activation_is_not_revocation() {
        for service in [GNOME_LOCK, KDE_LOCK] {
            let bus = TestBus::with_activation(true);
            let (ready, mut task) = monitor(&bus, service).await;
            tokio::time::timeout(Duration::from_secs(5), ready).await.unwrap().unwrap().unwrap();
            assert!(tokio::time::timeout(Duration::from_millis(100), &mut task).await.is_err(),
                "The initial activation must not revoke an unlocked desktop");
            task.abort();
        }
    }

    #[test]
    fn scales_pixels_using_compositor_geometry_and_rejects_crops() {
        let mut region = crate::ei::Region { mapping_id: Some("monitor".into()), x: 1024, y: 120,
            width: 1024, height: 576, physical_scale: 1.25 };
        assert_eq!(coordinate_scale(1280, 720, &region).unwrap(), (0.8, 0.8));
        assert!(coordinate_scale(1280, 600, &region).is_err());
        region.width = 640; region.height = 360; region.physical_scale = 2.0;
        assert_eq!(coordinate_scale(1280, 720, &region).unwrap(), (0.5, 0.5));
        region.physical_scale = f64::NAN;
        assert!(coordinate_scale(1280, 720, &region).is_err());
    }
}
