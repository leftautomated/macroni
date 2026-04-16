//! Screen capture session abstraction. The `ScreenCaptureSession` orchestrates
//! frame pulls from `scap` and pushes them through a `CaptureSink`. A fake sink
//! backs the unit tests so the capture flow is verifiable without real scap.

use crate::types::{CaptureQuality, VideoMetadata};
#[cfg(test)]
use std::sync::{Arc, Mutex};

/// Raw captured frame in BGRA (scap's native format on macOS/Windows).
#[derive(Debug, Clone)]
pub struct Frame {
    pub width: u32,
    pub height: u32,
    pub data: Vec<u8>,
    pub timestamp_ms: i64,
}

/// Sink that receives encoded or raw frames. Implementations write to disk
/// (real encoder) or to memory (test fake).
pub trait CaptureSink: Send {
    fn on_frame(&mut self, frame: &Frame) -> Result<(), String>;
    fn finalize(self: Box<Self>) -> Result<VideoMetadata, String>;
}

/// Test-only sink that collects frames in memory.
#[cfg(test)]
#[derive(Default)]
pub struct FakeSink {
    pub frames: Arc<Mutex<Vec<Frame>>>,
    pub start_ms: i64,
    pub fps: u32,
}

#[cfg(test)]
impl CaptureSink for FakeSink {
    fn on_frame(&mut self, frame: &Frame) -> Result<(), String> {
        self.frames.lock().unwrap().push(frame.clone());
        Ok(())
    }
    fn finalize(self: Box<Self>) -> Result<VideoMetadata, String> {
        let frames = self.frames.lock().unwrap();
        let duration_ms = frames.last().map(|f| f.timestamp_ms - self.start_ms).unwrap_or(0);
        let (width, height) = frames.first().map(|f| (f.width, f.height)).unwrap_or((0, 0));
        Ok(VideoMetadata {
            path: String::from("<fake>"),
            start_ms: self.start_ms,
            duration_ms,
            width,
            height,
            fps: self.fps,
            has_audio: false,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fake_sink_collects_frames_and_reports_duration() {
        let frames_handle: Arc<Mutex<Vec<Frame>>> = Arc::new(Mutex::new(Vec::new()));
        let mut sink = Box::new(FakeSink {
            frames: Arc::clone(&frames_handle),
            start_ms: 1000,
            fps: 30,
        });
        sink.on_frame(&Frame { width: 640, height: 360, data: vec![0; 640 * 360 * 4], timestamp_ms: 1000 }).unwrap();
        sink.on_frame(&Frame { width: 640, height: 360, data: vec![0; 640 * 360 * 4], timestamp_ms: 1033 }).unwrap();
        sink.on_frame(&Frame { width: 640, height: 360, data: vec![0; 640 * 360 * 4], timestamp_ms: 1066 }).unwrap();

        let meta = sink.finalize().unwrap();
        assert_eq!(meta.duration_ms, 66);
        assert_eq!(meta.width, 640);
        assert_eq!(meta.fps, 30);
        assert_eq!(frames_handle.lock().unwrap().len(), 3);
    }
}

/// Unused in FakeSink tests but kept here to silence unused import warnings.
#[allow(dead_code)]
fn _quality_to_crf(q: CaptureQuality) -> u8 {
    q.crf()
}
