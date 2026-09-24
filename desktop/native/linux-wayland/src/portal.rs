//! One explicitly selected monitor, with a shared capture/input session.
use crate::{capture::{Capture, Frame}, ei::Sender};
use anyhow::{anyhow, ensure, Context, Result};
use ashpd::desktop::{remote_desktop::{DeviceType, RemoteDesktop, SelectDevicesOptions},
    screencast::{CursorMode, Screencast, SelectSourcesOptions, SourceType}, PersistMode, Session};
use futures_util::StreamExt;
use std::{sync::Arc, time::Duration};
use tokio::sync::{oneshot, watch};

#[zbus::proxy(interface = "org.gnome.ScreenSaver", default_service = "org.gnome.ScreenSaver", default_path = "/org/gnome/ScreenSaver")]
trait ScreenSaver {
    fn get_active(&self) -> zbus::Result<bool>;
    #[zbus(signal)]
    fn active_changed(&self, active: bool) -> zbus::Result<()>;
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
        // Electron does not emit lock-screen on every Linux desktop. GNOME's
        // documented session service is mandatory for this initial GNOME lane.
        // Subscribe before checking the current state to avoid a lock race.
        screen.watchers.push(tokio::spawn(async move {
            let mut ready = Some(lock_ready);
            let monitor = async {
                let proxy = ScreenSaverProxy::new(&connection).await?;
                let mut changes = proxy.receive_active_changed().await?;
                ensure!(!proxy.get_active().await?, "Unlock the desktop before sharing a screen");
                let _ = ready.take().unwrap().send(Ok::<_, anyhow::Error>(()));
                while let Some(change) = changes.next().await {
                    if change.args()?.active { break; }
                }
                Ok::<_, anyhow::Error>(())
            }.await;
            if let Some(ready) = ready { let _ = ready.send(monitor); }
            lock_sender.send_replace(true);
        }));
        if let Err(error) = lock_subscribed.await.context("Screen-lock monitor ended").and_then(|r| r) {
            screen.close().await.ok();
            return Err(error.context("GNOME screen-lock monitoring is unavailable"));
        }
        let mut revoked = screen.closed.clone();
        let operation = async {
            remote.select_devices(&screen.session, SelectDevicesOptions::default()
                .set_devices(DeviceType::Keyboard | DeviceType::Pointer).set_persist_mode(PersistMode::DoNot)).await?.response()?;
            cast.select_sources(&screen.session, SelectSourcesOptions::default()
                .set_sources(Some(SourceType::Monitor.into())).set_multiple(false)
                .set_cursor_mode(CursorMode::Embedded).set_persist_mode(PersistMode::DoNot)).await?.response()?;
            let selection = remote.start(&screen.session, None, Default::default()).await?.response()?;
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
