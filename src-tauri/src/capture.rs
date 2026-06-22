//! Screen capture session abstraction. The `ScreenCaptureSession` orchestrates
//! frame pulls from `scap` and pushes them through a `CaptureSink`. A fake sink
//! backs the unit tests so the capture flow is verifiable without real scap.

use crate::types::VideoMetadata;
use std::sync::Arc;
#[cfg(test)]
use std::sync::Mutex;

/// Raw captured frame in BGRA (scap's native format on macOS/Windows).
#[derive(Debug, Clone)]
#[allow(dead_code)] // width/height belong to the Frame contract; consumers may not read them
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
    /// Re-emit the most recent frame at `timestamp_ms`, to hold a steady frame
    /// rate during static periods. Default no-op (sinks that don't encode video
    /// can ignore it).
    fn repeat_last(&mut self, _timestamp_ms: i64) -> Result<(), String> {
        Ok(())
    }
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
        let duration_ms = frames
            .last()
            .map(|f| f.timestamp_ms - self.start_ms)
            .unwrap_or(0);
        let (width, height) = frames
            .first()
            .map(|f| (f.width, f.height))
            .unwrap_or((0, 0));
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

use crate::types::CaptureSettings;
use chrono::Utc;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::JoinHandle;

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
    #[allow(dead_code)] // exposed via start_ms() accessor for future callers
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
        // In open-gpui-scap, `Frame` is an alias for `VideoFrame`, so BGRA frames
        // are matched as `ScapFrame::BGRA(_)` directly (no `Frame::Video` wrapper).
        use scap::frame::{Frame as ScapFrame, FrameType};

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
                // Capture at native resolution. ScreenCaptureKit's *scaled* output
                // path (output_resolution != Captured) appears to stall frame
                // delivery in scap 0.1.0-beta (only one frame arrives). We capture
                // native and downscale on the CPU (`fit_bgra`) to stay within
                // openh264's 4K limit instead.
                output_resolution: scap::capturer::Resolution::Captured,
                // (open-gpui-scap has no audio capture; not needed for v1.)
                ..Default::default()
            };
            let mut capturer = Capturer::build(opts).map_err(|e| format!("{:?}", e))?;
            capturer.start_capture();

            // Pull frames until we see the first non-empty BGRA video frame. scap
            // 0.1 interleaves audio frames (skip) and emits empty 0x0 BGRA frames
            // for ScreenCaptureKit `.idle` (no-change) status (also skip).
            let (width, height, first_data, first_ts) = loop {
                let frame = capturer.get_next_frame().map_err(|e| format!("{:?}", e))?;
                match frame {
                    ScapFrame::BGRA(f) if f.width > 0 && !f.data.is_empty() => {
                        break (
                            f.width as u32,
                            f.height as u32,
                            f.data,
                            Utc::now().timestamp_millis(),
                        );
                    }
                    _ => continue,
                }
            };

            // openh264 rejects anything above 3840x2160 (or 2160x3840). scap's
            // _2160p preset clamps most displays, but for non-16:9 aspects the
            // height can still exceed 2160, so compute a guaranteed-fitting,
            // aspect-preserving, even-valued target and downscale frames to it.
            // This is a no-op when capture is already within the box.
            let (enc_w, enc_h) = encode_target(width, height);
            eprintln!("capture: source {width}x{height} -> encode {enc_w}x{enc_h}");

            let mut sink: Box<dyn CaptureSink> = Box::new(crate::encoder::Mp4EncoderSink::new(
                output_path.clone(),
                enc_w,
                enc_h,
                settings.fps,
                settings.quality,
                settings.audio,
                start_ms,
            )?);
            sink.on_frame(&Frame {
                width: enc_w,
                height: enc_h,
                data: fit_bgra(first_data, width, height, enc_w, enc_h),
                timestamp_ms: first_ts,
            })?;

            // ScreenCaptureKit only delivers a frame when screen content changes,
            // so to keep a steady frame rate we re-emit the previous frame at the
            // target interval to fill the gap before each new real frame (and
            // after the last one, below). `backfill` caps a single gap so a clock
            // anomaly can't enqueue an unbounded number of frames.
            let frame_interval_ms = (1000 / settings.fps.max(1)).max(1) as i64;
            let mut prev_ts = first_ts;
            let backfill = |sink: &mut Box<dyn CaptureSink>, from: i64, to: i64| {
                let mut t = from + frame_interval_ms;
                let mut filled = 0u32;
                while t < to && filled < 36_000 {
                    if let Err(e) = sink.repeat_last(t) {
                        eprintln!("capture: repeat error {e}");
                        break;
                    }
                    t += frame_interval_ms;
                    filled += 1;
                }
            };

            let mut frame_count: u32 = 1; // real frames only (backfill not counted)
            while running_thread.load(Ordering::Relaxed) {
                match capturer.get_next_frame() {
                    Ok(ScapFrame::BGRA(f)) if f.width > 0 && !f.data.is_empty() => {
                        frame_count += 1;
                        let ts = Utc::now().timestamp_millis();
                        let (fw, fh) = (f.width as u32, f.height as u32);
                        backfill(&mut sink, prev_ts, ts);
                        if let Err(e) = sink.on_frame(&Frame {
                            width: enc_w,
                            height: enc_h,
                            data: fit_bgra(f.data, fw, fh, enc_w, enc_h),
                            timestamp_ms: ts,
                        }) {
                            eprintln!("capture: sink error {e}");
                            break;
                        }
                        prev_ts = ts;
                    }
                    Ok(_) => continue, // audio / idle (empty) frame — ignore
                    Err(e) => {
                        eprintln!("capture: frame error {:?}", e);
                        break;
                    }
                }
            }
            // Fill the final gap from the last real frame to stop time so the
            // video runs the full recording length even if the screen was static
            // at the end.
            backfill(&mut sink, prev_ts, Utc::now().timestamp_millis());
            eprintln!("capture: {frame_count} real frames captured (gaps filled to steady fps)");

            capturer.stop_capture();
            sink.finalize()
        });

        Ok(Self {
            running,
            handle: Some(handle),
            start_ms,
        })
    }

    pub fn stop(mut self) -> Result<VideoMetadata, String> {
        self.running.store(false, Ordering::Relaxed);
        let handle = self.handle.take().ok_or("already stopped")?;
        handle
            .join()
            .map_err(|_| "capture thread panicked".to_string())?
    }

    #[allow(dead_code)] // future callers / debugging — keep public
    pub fn start_ms(&self) -> i64 {
        self.start_ms
    }
}

/// Fit `(w, h)` into openh264's encode box (longer side <= 3840, shorter <=
/// 2160), preserving aspect, never upscaling, rounded to even dimensions
/// (required by I420 chroma subsampling).
#[cfg(not(target_os = "windows"))]
fn encode_target(w: u32, h: u32) -> (u32, u32) {
    const MAX_LONG: f64 = 3840.0;
    const MAX_SHORT: f64 = 2160.0;
    let (wf, hf) = (w as f64, h as f64);
    let (long, short) = if wf >= hf { (wf, hf) } else { (hf, wf) };
    let scale = (MAX_LONG / long).min(MAX_SHORT / short).min(1.0);
    let round_even = |v: f64| {
        let n = (v * scale).round() as u32;
        (n - n % 2).max(2)
    };
    (round_even(wf), round_even(hf))
}

/// Downscale a BGRA frame to `(tw, th)`. No-op if already that size. A separable
/// bilinear resize filters each byte-lane independently, so BGRA channel order
/// is preserved (no need to reorder to RGBA).
#[cfg(not(target_os = "windows"))]
fn fit_bgra(data: Vec<u8>, w: u32, h: u32, tw: u32, th: u32) -> Vec<u8> {
    if (w, h) == (tw, th) {
        return data;
    }
    match image::RgbaImage::from_raw(w, h, data) {
        Some(img) => {
            image::imageops::resize(&img, tw, th, image::imageops::FilterType::Triangle).into_raw()
        }
        // Length mismatch should be impossible for a BGRA frame; degrade to an
        // empty buffer, which surfaces a visible encoder error rather than a panic.
        None => Vec::new(),
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
        sink.on_frame(&Frame {
            width: 640,
            height: 360,
            data: vec![0; 640 * 360 * 4],
            timestamp_ms: 1000,
        })
        .unwrap();
        sink.on_frame(&Frame {
            width: 640,
            height: 360,
            data: vec![0; 640 * 360 * 4],
            timestamp_ms: 1033,
        })
        .unwrap();
        sink.on_frame(&Frame {
            width: 640,
            height: 360,
            data: vec![0; 640 * 360 * 4],
            timestamp_ms: 1066,
        })
        .unwrap();

        let meta = sink.finalize().unwrap();
        assert_eq!(meta.duration_ms, 66);
        assert_eq!(meta.width, 640);
        assert_eq!(meta.fps, 30);
        assert_eq!(frames_handle.lock().unwrap().len(), 3);
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn encode_target_fits_openh264_box() {
        // 16:9 5K / 6K -> exactly 4K
        assert_eq!(encode_target(5120, 2880), (3840, 2160));
        assert_eq!(encode_target(6016, 3384), (3840, 2160));
        // 16:10 wider-than-4K -> height clamped to 2160, aspect preserved
        let (w, h) = encode_target(3840, 2400);
        assert!(w <= 3840 && h <= 2160, "got {w}x{h}");
        assert_eq!(h, 2160);
        // already within the box -> unchanged; never upscale a small source
        assert_eq!(encode_target(1920, 1080), (1920, 1080));
        assert_eq!(encode_target(1280, 720), (1280, 720));
        // portrait within the rotated box -> unchanged; tall portrait -> clamped
        assert_eq!(encode_target(2160, 3840), (2160, 3840));
        let (w, h) = encode_target(2880, 5120);
        assert!(w <= 2160 && h <= 3840, "got {w}x{h}");
        // dimensions are always even (I420 requirement)
        let (w, h) = encode_target(5121, 2881);
        assert_eq!((w % 2, h % 2), (0, 0));
    }
}
