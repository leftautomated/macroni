//! Screen capture session abstraction. The `ScreenCaptureSession` orchestrates
//! frame pulls from `scap` and pushes them through a `CaptureSink`. A fake sink
//! backs the unit tests so the capture flow is verifiable without real scap.

use crate::types::{CaptureQuality, VideoMetadata};
use std::sync::Arc;
#[cfg(test)]
use std::sync::Mutex;

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

use crate::types::CaptureSettings;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::JoinHandle;
use chrono::Utc;

/// Configuration for starting a capture session. Built from AppSettings at runtime.
pub struct CaptureConfig {
    pub output_path: PathBuf,
    pub settings: CaptureSettings,
}

/// A live capture session. Start spawns a scap thread; stop signals it to finish
/// and finalizes the sink into a VideoMetadata.
pub struct ScreenCaptureSession {
    running: Arc<AtomicBool>,
    handle: Option<JoinHandle<Result<VideoMetadata, String>>>,
    start_ms: i64,
}

impl ScreenCaptureSession {
    /// Start a screen capture session.
    ///
    /// On Windows this currently returns `Err("windows-capture-unsupported")`
    /// because scap's upstream Windows path does not compile against the
    /// current `windows-capture` dependency. The caller treats non-
    /// permission-denied errors as "no video, keep recording events" so the
    /// app still works — just without the video half of the preview feature.
    /// Revisit when upstream scap fixes Windows or when we replace the
    /// cross-platform capture layer.
    #[cfg(target_os = "windows")]
    pub fn start(_config: CaptureConfig) -> Result<Self, String> {
        Err("windows-capture-unsupported".to_string())
    }

    #[cfg(not(target_os = "windows"))]
    pub fn start(config: CaptureConfig) -> Result<Self, String> {
        use scap::capturer::{Capturer, Options};
        use scap::frame::{Frame as ScapFrame, FrameType, VideoFrame};

        if !scap::is_supported() {
            return Err("Screen capture is not supported on this platform".to_string());
        }
        if !scap::has_permission() {
            return Err("permission-denied".to_string());
        }

        let start_ms = Utc::now().timestamp_millis();
        let running = Arc::new(AtomicBool::new(true));
        let running_thread = Arc::clone(&running);
        let settings = config.settings;
        let output_path = config.output_path.clone();

        let handle = std::thread::spawn(move || -> Result<VideoMetadata, String> {
            let opts = Options {
                fps: settings.fps,
                show_cursor: true,
                show_highlight: false,
                target: None,
                crop_area: None,
                output_type: FrameType::BGRAFrame,
                output_resolution: scap::capturer::Resolution::Captured,
                captures_audio: settings.audio,
                ..Default::default()
            };
            let mut capturer = Capturer::build(opts).map_err(|e| format!("{:?}", e))?;
            capturer.start_capture();

            // Pull frames until we see the first BGRA video frame — scap 0.1 may
            // interleave audio frames, so we skip those rather than bailing.
            let (width, height, first_data, first_ts) = loop {
                let frame = capturer.get_next_frame().map_err(|e| format!("{:?}", e))?;
                match frame {
                    ScapFrame::Video(VideoFrame::BGRA(f)) => {
                        break (f.width as u32, f.height as u32, f.data, Utc::now().timestamp_millis());
                    }
                    _ => continue,
                }
            };

            let mut sink: Box<dyn CaptureSink> = Box::new(
                crate::encoder::Mp4EncoderSink::new(
                    output_path.clone(),
                    width,
                    height,
                    settings.fps,
                    settings.quality,
                    settings.audio,
                    start_ms,
                )?,
            );
            sink.on_frame(&Frame { width, height, data: first_data, timestamp_ms: first_ts })?;

            while running_thread.load(Ordering::Relaxed) {
                match capturer.get_next_frame() {
                    Ok(ScapFrame::Video(VideoFrame::BGRA(f))) => {
                        let ts = Utc::now().timestamp_millis();
                        if let Err(e) = sink.on_frame(&Frame {
                            width: f.width as u32,
                            height: f.height as u32,
                            data: f.data,
                            timestamp_ms: ts,
                        }) {
                            eprintln!("capture: sink error {e}");
                            break;
                        }
                    }
                    Ok(_) => continue, // audio frame or other video format — ignore for now
                    Err(e) => {
                        eprintln!("capture: frame error {:?}", e);
                        break;
                    }
                }
            }

            capturer.stop_capture();
            sink.finalize()
        });

        Ok(Self { running, handle: Some(handle), start_ms })
    }

    pub fn stop(mut self) -> Result<VideoMetadata, String> {
        self.running.store(false, Ordering::Relaxed);
        let handle = self.handle.take().ok_or("already stopped")?;
        handle.join().map_err(|_| "capture thread panicked".to_string())?
    }

    pub fn start_ms(&self) -> i64 {
        self.start_ms
    }
}
