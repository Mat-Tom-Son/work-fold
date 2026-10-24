//! Bounded CPU frames through the portal-granted PipeWire connection only.
use anyhow::{ensure, Context, Result};
use gstreamer::{self as gst, prelude::*};
use gstreamer_app::AppSink;
use gstreamer_video::prelude::*;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{os::fd::{AsRawFd, OwnedFd}, sync::{Arc, Mutex}, time::{Duration, SystemTime, UNIX_EPOCH}};

pub const MAX_DIMENSION: u32 = 4096;
pub const MAX_BYTES: usize = 128 * 1024 * 1024;

pub struct Capture {
    pipeline: gst::Pipeline,
    sink: AppSink,
    // Drop the media pipeline before closing the descriptor it borrowed.
    _remote: Option<OwnedFd>,
    latest: Mutex<Option<Frame>>,
}

impl Drop for Capture {
    fn drop(&mut self) { let _ = self.pipeline.set_state(gst::State::Null); }
}

#[derive(Debug, Clone, Serialize)]
pub struct FrameInfo {
    pub width: u32,
    pub height: u32,
    pub stride: usize,
    pub format: &'static str,
    pub bytes: usize,
    pub sha256: String,
    #[serde(rename = "capturedAtMs")]
    pub captured_at_ms: u64,
}

#[derive(Clone)]
pub struct Frame { pub info: FrameInfo, pixels: Arc<[u8]> }

impl Frame {
    pub fn from_sample(sample: &gst::Sample) -> Result<Self> {
        let info = gstreamer_video::VideoInfo::from_caps(sample.caps().context("Missing video caps")?)?;
        ensure!(info.format() == gstreamer_video::VideoFormat::Rgba, "Unsupported frame format");
        ensure!(info.width() > 0 && info.height() > 0 && info.width() <= MAX_DIMENSION
            && info.height() <= MAX_DIMENSION && info.size() <= MAX_BYTES, "Frame exceeds limits");
        let frame = gstreamer_video::VideoFrameRef::from_buffer_ref_readable(
            sample.buffer().context("Missing frame buffer")?, &info).context("Frame is not CPU readable")?;
        // VideoMeta may change a buffer's plane offset and stride. Use the
        // framework's mapped frame, never assume tightly packed buffer bytes.
        let info = frame.info();
        let map = frame.plane_data(0)?;
        let stride = usize::try_from(info.stride()[0])?;
        let row = info.width() as usize * 4;
        ensure!(map.len() <= MAX_BYTES && stride >= row
            && stride.checked_mul(info.height() as usize).is_some_and(|size| size <= map.len()), "Invalid frame stride");
        let pixels: Vec<u8> = map.chunks(stride).take(info.height() as usize)
            .flat_map(|row| row[..info.width() as usize * 4].iter().copied()).collect();
        Ok(Self { info: FrameInfo { width: info.width(), height: info.height(), stride,
            format: "RGBA", bytes: pixels.len(), sha256: format!("{:x}", Sha256::digest(&pixels)),
            captured_at_ms: SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis().try_into()? }, pixels: pixels.into() })
    }

    pub fn png(&self) -> Result<Vec<u8>> {
        let mut encoded = Vec::new();
        let mut encoder = png::Encoder::new(&mut encoded, self.info.width, self.info.height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.write_header()?.write_image_data(&self.pixels)?;
        ensure!(encoded.len() <= 24 * 1024 * 1024, "PNG exceeds the observation limit");
        Ok(encoded)
    }
}

impl Capture {
    fn pipeline(source: gst::Element, remote: Option<OwnedFd>) -> Result<Self> {
        let pipeline = gst::Pipeline::new();
        let convert = gst::ElementFactory::make("videoconvert").build()?;
        let sink = AppSink::builder().caps(&gst::Caps::builder("video/x-raw")
            .field("format", "RGBA")
            .field("width", gst::IntRange::<i32>::new(1, MAX_DIMENSION as i32))
            .field("height", gst::IntRange::<i32>::new(1, MAX_DIMENSION as i32)).build())
            .max_buffers(1).drop(true).sync(false).build();
        let capture = Self { pipeline, sink, _remote: remote, latest: Mutex::new(None) };
        capture.pipeline.add_many([&source, &convert, capture.sink.upcast_ref()])?;
        gst::Element::link_many([&source, &convert, capture.sink.upcast_ref()])?;
        capture.pipeline.set_state(gst::State::Playing)?;
        Ok(capture)
    }

    pub async fn portal(remote: OwnedFd, node: u32) -> Result<Self> {
        // Native state changes can block on a failed media service. Keep the
        // async portal-close path runnable; the owning process also requires
        // an independent kill-and-reap deadline from its desktop host.
        tokio::task::spawn_blocking(move || {
            let source = gst::ElementFactory::make("pipewiresrc")
                .property("fd", remote.as_raw_fd()).property("path", node.to_string())
                .property("do-timestamp", true).build()?;
            Self::pipeline(source, Some(remote))
        }).await?
    }

    pub fn test_pattern() -> Result<Self> {
        let source = gst::ElementFactory::make("videotestsrc")
            .property("num-buffers", 1i32).property_from_str("pattern", "smpte").build()?;
        Self::pipeline(source, None)
    }

    pub async fn frame(&self) -> Result<Frame> {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            if let Some(sample) = self.sink.try_pull_sample(gst::ClockTime::ZERO) {
                let frame = Frame::from_sample(&sample)?;
                *self.latest.lock().map_err(|_| anyhow::anyhow!("Frame cache failed"))? = Some(frame.clone());
                return Ok(frame);
            }
            ensure!(!self.sink.is_eos(), "Capture ended before a frame arrived");
            if let Some(message) = self.pipeline.bus().and_then(|bus| bus.pop_filtered(&[gst::MessageType::Error])) {
                anyhow::bail!("Capture pipeline failed: {:?}", message.type_());
            }
            // PipeWire can send frames only when pixels change. Reuse only
            // this live stream's latest image, retaining its real timestamp.
            if let Some(frame) = self.latest.lock().map_err(|_| anyhow::anyhow!("Frame cache failed"))?.as_ref() {
                return Ok(frame.clone());
            }
            ensure!(tokio::time::Instant::now() < deadline, "Timed out waiting for a usable frame");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn framework_frame_and_png_have_matching_dimensions() {
        gst::init().unwrap();
        let capture = Capture::test_pattern().unwrap();
        let frame = capture.frame().await.unwrap();
        let png = frame.png().unwrap();
        let decoder = png::Decoder::new(std::io::Cursor::new(png)).read_info().unwrap();
        assert_eq!((decoder.info().width, decoder.info().height), (frame.info.width, frame.info.height));
        assert_eq!(frame.pixels.len(), frame.info.width as usize * frame.info.height as usize * 4);
    }
    #[test]
    fn missing_and_oversized_caps_fail_before_mapping() {
        gst::init().unwrap();
        assert!(Frame::from_sample(&gst::Sample::builder().build()).is_err());
        let caps = gst::Caps::builder("video/x-raw").field("format", "RGBA")
            .field("width", 16384i32).field("height", 16384i32).build();
        assert!(Frame::from_sample(&gst::Sample::builder().caps(&caps).build()).is_err());
    }
}
