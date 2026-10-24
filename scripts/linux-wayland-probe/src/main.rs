//! Contributor-only feasibility probe. Not bundled or callable by a Worker.
//! Default mode reads capabilities. Capture requires the explicit --capture
//! argument and the compositor's chooser. Input is confined to the guarded
//! synthetic-seat test command; ordinary interactive capture sends no input.
use anyhow::{anyhow, ensure, Context, Result};
use ashpd::desktop::{remote_desktop::RemoteDesktop, screencast::Screencast};
use work_fold_wayland::portal::SharedScreen;
use gstreamer as gst;
use serde_json::{json, Value};
use std::time::Duration;
use work_fold_wayland::capture::{Capture, Frame};

fn report_frame(frame: Frame) -> Result<Value> {
    if std::env::var("WORKFOLD_ISOLATED_GNOME_TEST").as_deref() == Ok("1")
        && (std::path::Path::new("/run/.containerenv").exists()
            || std::path::Path::new("/.dockerenv").exists())
        && std::path::Path::new("/tmp/workfold-input-fixture/events.json").is_file()
    {
        std::fs::write("/tmp/workfold-input-fixture/capture.png", frame.png()?)?;
    }
    Ok(serde_json::to_value(frame.info)?)
}

async fn test_pattern() -> Result<Value> {
    let capture = Capture::test_pattern()?;
    Ok(json!({ "mode": "test-pattern", "desktopCaptured": false,
        "frame": report_frame(capture.frame().await?)? }))
}

async fn diagnose() -> Result<Value> {
    let remote = RemoteDesktop::new().await?;
    let cast = Screencast::with_connection(remote.connection().clone()).await?;
    Ok(
        json!({ "mode": "diagnose", "desktopCaptured": false, "inputSent": false,
            "remoteDesktop": { "version": remote.version(), "devices": remote.available_device_types().await?.bits() },
            "screenCast": { "version": cast.version(), "sources": cast.available_source_types().await?.bits(),
                "cursorModes": cast.available_cursor_modes().await?.bits() },
            "gstreamer": gst::version_string().as_str(),
            "plugins": (["pipewiresrc", "videoconvert", "appsink"].map(|name| json!({ "name": name, "available": gst::ElementFactory::find(name).is_some() })))
        }),
    )
}

async fn capture(test_input: bool) -> Result<Value> {
    eprintln!("Choose the isolated test monitor. The ordinary capture command sends no input.");
    let mut screen = SharedScreen::request(async { let _ = tokio::signal::ctrl_c().await; }).await?;
    let operation = async {
        let frame = screen.frame().await?;
        let mapping = screen.input_mapping(&frame).ok().map(str::to_owned);
        let snapshot = report_frame(frame)?;
        if test_input {
            ensure!(screen.logical_size == Some((1280, 720)), "Unexpected isolated monitor size");
            let mapping = mapping.as_deref().context("No qualified monitor input mapping")?;
            let sender = screen.input.as_mut().context("Missing granted EIS sender")?;
            // A private headless seat gains keyboard focus only after EIS has
            // created its input devices. This assertion never targets a user's
            // desktop, adopts another window, or retries an event.
            tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    sender.dispatch()?;
                    let state: Value = serde_json::from_slice(&std::fs::read("/tmp/workfold-input-fixture/events.json")?)?;
                    if state["active"] == true && state["mapped"] == true { break Ok::<_, anyhow::Error>(()); }
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            }).await.context("Isolated native target did not receive focus")??;
            sender.move_absolute(mapping, 500.0, 160.0)?;
            tokio::time::sleep(Duration::from_millis(100)).await;
            sender.click(mapping, 500.0, 160.0, 272, 1)?;
            tokio::time::sleep(Duration::from_millis(200)).await;
            sender.type_text("Wayland native input verified.")?;
            tokio::time::sleep(Duration::from_millis(200)).await;
            sender.scroll(mapping, 500.0, 160.0, 0.0, 120.0)?;
            sender.shortcut(&["Ctrl".to_owned(), "s".to_owned()])?;
            tokio::time::sleep(Duration::from_millis(300)).await;
            sender.dispatch()?;
        }
        Ok::<_, anyhow::Error>(json!({
            "mode": if test_input { "isolated-input-test" } else { "capture" },
            "desktopCaptured": true, "inputSent": test_input, "frame": snapshot,
            "devicesGranted": screen.devices, "logicalSize": screen.logical_size,
            "logicalPosition": screen.logical_position, "mappingIdPresent": screen.mapping_id.is_some(),
            "eisNegotiated": screen.input.is_some(), "uniqueInputRegionMatched": mapping.is_some(),
            "inputMappingVerified": false, "restoreTokenSaved": false,
        }))
    };
    let result = tokio::select! {
        result = tokio::time::timeout(Duration::from_secs(15), operation) => result.context("Capture/input test timed out").and_then(|r| r),
        _ = tokio::signal::ctrl_c() => Err(anyhow!("Portal probe cancelled")),
    };
    let closed = screen.close().await;
    match result {
        Ok(mut report) => { closed?; report["sessionClosed"] = json!(true); Ok(report) }
        Err(error) => {
            eprintln!("Portal session close: {}", if closed.is_ok() { "confirmed" } else { "unconfirmed" });
            Err(error)
        }
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    gst::init()?;
    let args: Vec<_> = std::env::args().skip(1).collect();
    let result = match args.as_slice() {
        [] => tokio::time::timeout(Duration::from_secs(10), diagnose()).await?,
        [mode] if mode == "--diagnose" => {
            tokio::time::timeout(Duration::from_secs(10), diagnose()).await?
        }
        [mode] if mode == "--test-pattern" => test_pattern().await,
        [mode] if mode == "--capture" => capture(false).await,
        [mode] if mode == "--isolated-input-test" => {
            ensure!(
                std::env::var("WORKFOLD_ISOLATED_GNOME_TEST").as_deref() == Ok("1")
                    && std::env::var("XDG_RUNTIME_DIR").as_deref() == Ok("/tmp/workfold-runtime")
                    && (std::path::Path::new("/run/.containerenv").exists()
                        || std::path::Path::new("/.dockerenv").exists())
                    && std::path::Path::new("/tmp/workfold-input-fixture/events.json").is_file(),
                "Input test requires the isolated fixture container"
            );
            capture(true).await
        }
        _ => Err(anyhow!(
            "Usage: work-fold-wayland-probe [--diagnose|--test-pattern|--capture]"
        )),
    }?;
    println!(
        "{}",
        serde_json::to_string_pretty(
            &json!({ "schema": "work-fold.wayland-probe.v1", "result": result })
        )?
    );
    Ok(())
}
