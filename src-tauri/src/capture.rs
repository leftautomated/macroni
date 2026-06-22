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
use std::sync::mpsc;
use std::thread::JoinHandle;
use std::time::Duration;

/// Configuration for starting a capture session. Built from AppSettings at runtime.
pub struct CaptureConfig {
    pub output_path: PathBuf,
    pub settings: CaptureSettings,
}

/// A raw frame handed from the acquisition thread to the encoder thread. Holds
/// native-resolution BGRA; the resize/encode happens on the encoder side.
#[cfg(not(target_os = "windows"))]
struct CapturedFrame {
    width: u32,
    height: u32,
    data: Vec<u8>,
    ts: i64,
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
        if !scap::is_supported() {
            return Err("Screen capture is not supported on this platform".to_string());
        }
        if !scap::has_permission() {
            return Err("permission-denied".to_string());
        }

        let start_ms = Utc::now().timestamp_millis();
        let running = Arc::new(AtomicBool::new(true));
        let settings = config.settings;
        let output_path = config.output_path.clone();

        // Raw frames flow acquisition -> encoder over a small bounded channel.
        // We DROP frames on backpressure rather than block acquisition: blocking
        // acquisition is exactly what stalls ScreenCaptureKit, because each
        // get_next_frame() holds an SCK IOSurface until it returns, and SCK's
        // pool is small. Draining fast keeps the stream delivering.
        let (frame_tx, frame_rx) = mpsc::sync_channel::<CapturedFrame>(3);

        // ── Acquisition thread: drain scap as fast as possible. ──────────────
        {
            let running = Arc::clone(&running);
            let fps = settings.fps;
            std::thread::spawn(move || {
                use scap::capturer::{Capturer, Options};
                // In open-gpui-scap, `Frame` is an alias for `VideoFrame`, so BGRA
                // frames are matched as `ScapFrame::BGRA(_)` (no `Video` wrapper).
                use scap::frame::{Frame as ScapFrame, FrameType};

                let opts = Options {
                    fps,
                    show_cursor: true,
                    show_highlight: false,
                    output_type: FrameType::BGRAFrame,
                    output_resolution: scap::capturer::Resolution::Captured,
                    ..Default::default()
                };
                let mut capturer = match Capturer::build(opts) {
                    Ok(c) => c,
                    Err(e) => {
                        eprintln!("capture: build failed {e:?}");
                        return; // frame_tx drops -> encoder finishes with "no frames"
                    }
                };
                capturer.start_capture();

                let mut received: u64 = 0;
                let mut dropped: u64 = 0;
                while running.load(Ordering::Relaxed) {
                    match capturer.get_next_frame() {
                        // scap emits empty 0x0 BGRA frames for SCK `.idle` status; skip.
                        Ok(ScapFrame::BGRA(f)) if f.width > 0 && !f.data.is_empty() => {
                            received += 1;
                            let frame = CapturedFrame {
                                width: f.width as u32,
                                height: f.height as u32,
                                data: f.data,
                                ts: Utc::now().timestamp_millis(),
                            };
                            match frame_tx.try_send(frame) {
                                Ok(()) => {}
                                // Encoder behind — drop this frame, keep draining.
                                Err(mpsc::TrySendError::Full(_)) => dropped += 1,
                                Err(mpsc::TrySendError::Disconnected(_)) => break,
                            }
                        }
                        Ok(_) => continue, // audio / idle frame
                        Err(e) => {
                            eprintln!("capture: frame error {e:?}");
                            break;
                        }
                    }
                }
                capturer.stop_capture();
                eprintln!(
                    "capture: SCK delivered {received} frames, dropped {dropped} (encoder behind)"
                );
                // frame_tx dropped here -> encoder sees Disconnected.
            });
        }

        // ── Encoder thread: resize + encode at a steady fps. ─────────────────
        let handle = {
            let running = Arc::clone(&running);
            std::thread::spawn(move || -> Result<VideoMetadata, String> {
                let interval = Duration::from_millis((1000 / settings.fps.max(1)).max(1) as u64);
                let interval_ms = interval.as_millis() as i64;

                // Wait for the first real frame, checking `running` so a dead
                // capture (no frames) doesn't hang stop.
                let first = loop {
                    match frame_rx.recv_timeout(Duration::from_millis(200)) {
                        Ok(f) => break f,
                        Err(mpsc::RecvTimeoutError::Timeout) => {
                            if !running.load(Ordering::Relaxed) {
                                return Err("no video frames captured".to_string());
                            }
                        }
                        Err(mpsc::RecvTimeoutError::Disconnected) => {
                            return Err("capture ended before any frame".to_string());
                        }
                    }
                };

                // Downscale target so openh264 (max 3840x2160 / 2160x3840) accepts
                // any display, aspect-preserving and even-valued.
                let (enc_w, enc_h) = encode_target(first.width, first.height);
                eprintln!(
                    "capture: source {}x{} -> encode {enc_w}x{enc_h}",
                    first.width, first.height
                );

                let mut sink: Box<dyn CaptureSink> = Box::new(crate::encoder::Mp4EncoderSink::new(
                    output_path,
                    enc_w,
                    enc_h,
                    settings.fps,
                    settings.quality,
                    settings.audio,
                    start_ms,
                )?);
                // Pass native frames straight through; the encoder fuses the
                // downscale-to-(enc_w,enc_h) into its I420 conversion.
                sink.on_frame(&Frame {
                    width: first.width,
                    height: first.height,
                    data: first.data,
                    timestamp_ms: first.ts,
                })?;

                // Re-emit the last frame to cover any gap, keeping a steady rate.
                let backfill = |sink: &mut Box<dyn CaptureSink>, from: i64, to: i64| {
                    let mut t = from + interval_ms;
                    let mut filled = 0u32;
                    while t < to && filled < 36_000 {
                        if sink.repeat_last(t).is_err() {
                            break;
                        }
                        t += interval_ms;
                        filled += 1;
                    }
                };

                let mut prev_ts = first.ts;
                let mut real_frames: u32 = 1;
                loop {
                    match frame_rx.recv_timeout(interval) {
                        Ok(f) => {
                            real_frames += 1;
                            backfill(&mut sink, prev_ts, f.ts);
                            if let Err(e) = sink.on_frame(&Frame {
                                width: f.width,
                                height: f.height,
                                data: f.data,
                                timestamp_ms: f.ts,
                            }) {
                                eprintln!("capture: sink error {e}");
                                break;
                            }
                            prev_ts = f.ts;
                        }
                        // No new frame this interval: if still recording, hold the
                        // last frame (screen was static); else finish.
                        Err(mpsc::RecvTimeoutError::Timeout) => {
                            if !running.load(Ordering::Relaxed) {
                                break;
                            }
                            let t = prev_ts + interval_ms;
                            if sink.repeat_last(t).is_err() {
                                break;
                            }
                            prev_ts = t;
                        }
                        Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    }
                }
                backfill(&mut sink, prev_ts, Utc::now().timestamp_millis());
                eprintln!("capture: {real_frames} real frames encoded (steady fps)");
                sink.finalize()
            })
        };

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

/// Pick the encode resolution: fit `(w, h)` into a 1080p box (longer side <=
/// 1920, shorter <= 1080), preserving aspect, never upscaling, rounded to even
/// dimensions (I420 requirement). This is well within openh264's 4K hard limit
/// AND keeps software encode real-time — encoding native 4K/5K on the CPU only
/// manages a few fps, whereas 1080p is plenty to review a macro recording.
#[cfg(not(target_os = "windows"))]
fn encode_target(w: u32, h: u32) -> (u32, u32) {
    const MAX_LONG: f64 = 1920.0;
    const MAX_SHORT: f64 = 1080.0;
    let (wf, hf) = (w as f64, h as f64);
    let (long, short) = if wf >= hf { (wf, hf) } else { (hf, wf) };
    let scale = (MAX_LONG / long).min(MAX_SHORT / short).min(1.0);
    let round_even = |v: f64| {
        let n = (v * scale).round() as u32;
        (n - n % 2).max(2)
    };
    (round_even(wf), round_even(hf))
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
    fn encode_target_caps_at_1080p() {
        // 16:9 displays -> exactly 1080p
        assert_eq!(encode_target(5120, 2880), (1920, 1080));
        assert_eq!(encode_target(3840, 2160), (1920, 1080));
        // 16:10 -> longer<=1920, shorter<=1080, aspect preserved
        let (w, h) = encode_target(3456, 2234); // the test machine's display
        assert!(w <= 1920 && h <= 1080, "got {w}x{h}");
        assert_eq!(h, 1080);
        // already within the box -> unchanged; never upscale a small source
        assert_eq!(encode_target(1920, 1080), (1920, 1080));
        assert_eq!(encode_target(1280, 720), (1280, 720));
        // portrait within the rotated box -> unchanged; tall portrait -> clamped
        assert_eq!(encode_target(1080, 1920), (1080, 1920));
        let (w, h) = encode_target(2880, 5120);
        assert!(w <= 1080 && h <= 1920, "got {w}x{h}");
        // dimensions are always even (I420 requirement)
        let (w, h) = encode_target(3457, 2235);
        assert_eq!((w % 2, h % 2), (0, 0));
    }
}
