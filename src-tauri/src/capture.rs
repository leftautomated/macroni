//! Screen capture session abstraction. The `ScreenCaptureSession` orchestrates
//! frame pulls from `scap` and pushes them through a `CaptureSink`. A fake sink
//! backs the unit tests so the capture flow is verifiable without real scap.

use crate::types::VideoMetadata;
use std::sync::Arc;
#[cfg(test)]
use std::sync::Mutex;

/// Raw captured frame in BGRA (scap's native format on macOS).
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
    /// Optional sampled-frame tee for the perception worker. The acquisition
    /// loop rate-gates then `try_send`s clones here, dropping on backpressure —
    /// this side channel must NEVER block or slow the encoder path. `None` when
    /// continuous perception is off (the common case).
    pub tee: Option<mpsc::SyncSender<Frame>>,
}

/// A raw frame handed from the acquisition thread to the encoder thread. Holds
/// native-resolution BGRA; the resize/encode happens on the encoder side.
#[cfg(any(target_os = "macos", target_os = "windows"))]
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
    start_ms: i64,
}

impl ScreenCaptureSession {
    /// Start a screen capture session.
    ///
    /// Linux builds currently run event-only: the caller treats this as
    /// "no video, keep recording events" so the app still works without the
    /// video half of the preview feature.
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    pub fn start(_config: CaptureConfig) -> Result<Self, String> {
        Err("video-capture-unsupported-on-this-platform".to_string())
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn start(config: CaptureConfig) -> Result<Self, String> {
        check_capture_support()?;

        let start_ms = Utc::now().timestamp_millis();
        let running = Arc::new(AtomicBool::new(true));
        let settings = config.settings;
        let output_path = config.output_path.clone();
        // Perception tee (opt-in). Moved into the acquisition thread; `None` when
        // continuous perception is off, in which case the hot path is unchanged.
        let tee = config.tee;

        // Raw frames flow acquisition -> encoder over a small bounded channel.
        // We DROP frames on backpressure rather than block acquisition: blocking
        // acquisition is exactly what stalls ScreenCaptureKit, because each
        // get_next_frame() holds an SCK IOSurface until it returns, and SCK's
        // pool is small. Draining fast keeps the stream delivering.
        let (frame_tx, frame_rx) = mpsc::sync_channel::<CapturedFrame>(3);

        // ── Acquisition thread: drain scap as fast as possible. ──────────────
        {
            let running = Arc::clone(&running);
            std::thread::spawn(move || {
                let capturer = match start_platform_capture(settings.fps) {
                    Ok(c) => c,
                    Err(e) => {
                        crate::observability::log_error(
                            "capture",
                            "capturer_build_failed",
                            &e,
                            None,
                        );
                        return; // frame_tx drops -> encoder finishes with "no frames"
                    }
                };

                // Rate limiter for the perception tee: keeps the worker at ~1–2
                // fps regardless of capture fps. Only consulted when `tee` is Some.
                let mut gate = crate::perception::gate::SampleGate::new(
                    crate::perception::gate::SAMPLE_INTERVAL_MS,
                );

                while running.load(Ordering::Relaxed) {
                    match next_bgra_frame(&capturer) {
                        // The macOS backend emits empty 0x0 frames for SCK
                        // `.idle` status; both backends skip empty buffers.
                        Ok(Some((width, height, data))) => {
                            let ts = Utc::now().timestamp_millis();
                            // Tee a sampled copy to the perception worker BEFORE the
                            // encoder send. Gate first so we clone the 25–50 MB retina
                            // buffer only when a sample is due; `try_send` + drop on a
                            // full/absent channel so this never blocks the encoder path.
                            if let Some(tee) = &tee {
                                if gate.due(ts) {
                                    let _ = tee.try_send(Frame {
                                        width,
                                        height,
                                        data: data.clone(),
                                        timestamp_ms: ts,
                                    });
                                }
                            }
                            let frame = CapturedFrame {
                                width,
                                height,
                                data,
                                ts,
                            };
                            match frame_tx.try_send(frame) {
                                Ok(()) => {}
                                // Encoder behind — drop this frame, keep draining.
                                Err(mpsc::TrySendError::Full(_)) => {}
                                Err(mpsc::TrySendError::Disconnected(_)) => break,
                            }
                        }
                        Ok(None) => continue, // audio / idle / no frame ready
                        Err(e) => {
                            crate::observability::log_error("capture", "frame_error", &e, None);
                            break;
                        }
                    }
                }
                if let Err(error) = stop_platform_capture(capturer) {
                    crate::observability::log_warn("capture", "capturer_stop_failed", &error, None);
                }
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

                // One sample per wall-clock slot: the muxer writes fixed 1/fps
                // durations, so the pacer's bookkeeping IS the video timeline.
                // Repeats fill fully-elapsed empty slots (static screen); a
                // frame landing in an already-filled slot is dropped rather
                // than double-emitted (the old double-emit stretched videos
                // ~1.5× and desynced events/observations from the picture).
                let mut pacer = FramePacer::new(first.ts, interval_ms);
                let fill_elapsed = |sink: &mut Box<dyn CaptureSink>,
                                    pacer: &mut FramePacer,
                                    now: i64,
                                    cap: i64| {
                    let repeats = pacer.pending_repeats(now).min(cap);
                    for _ in 0..repeats {
                        if sink.repeat_last(pacer.next_slot_ts()).is_err() {
                            return false;
                        }
                        pacer.mark_emitted();
                    }
                    true
                };

                loop {
                    match frame_rx.recv_timeout(interval) {
                        Ok(f) => {
                            if !fill_elapsed(&mut sink, &mut pacer, f.ts, 36_000) {
                                break;
                            }
                            if !pacer.admit_frame(f.ts) {
                                continue; // slot already filled — drop, keep cadence
                            }
                            if let Err(e) = sink.on_frame(&Frame {
                                width: f.width,
                                height: f.height,
                                data: f.data,
                                timestamp_ms: f.ts,
                            }) {
                                crate::observability::log_error("capture", "sink_error", &e, None);
                                break;
                            }
                        }
                        // No new frame this interval: if still recording, hold the
                        // last frame for any fully-elapsed slot; else finish.
                        Err(mpsc::RecvTimeoutError::Timeout) => {
                            if !running.load(Ordering::Relaxed) {
                                break;
                            }
                            if !fill_elapsed(
                                &mut sink,
                                &mut pacer,
                                Utc::now().timestamp_millis(),
                                36_000,
                            ) {
                                break;
                            }
                        }
                        Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    }
                }
                fill_elapsed(&mut sink, &mut pacer, Utc::now().timestamp_millis(), 36_000);
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

    /// Wall-clock ms when capture started; the origin for video-relative
    /// timestamps. Consumed by the perception worker (video-relative stamps).
    pub fn start_ms(&self) -> i64 {
        self.start_ms
    }
}

#[cfg(target_os = "macos")]
type PlatformCapturer = scap::capturer::Capturer;

#[cfg(target_os = "windows")]
type PlatformCapturer = crate::windows_capture_backend::Capturer;

#[cfg(target_os = "macos")]
fn check_capture_support() -> Result<(), String> {
    if !scap::is_supported() {
        return Err("Screen capture is not supported on this platform".to_string());
    }
    if !scap::has_permission() {
        return Err("permission-denied".to_string());
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn check_capture_support() -> Result<(), String> {
    use windows_capture::graphics_capture_api::GraphicsCaptureApi;

    match GraphicsCaptureApi::is_supported() {
        Ok(true) => Ok(()),
        Ok(false) => Err("Screen capture requires Windows 10 version 1903 or newer".to_string()),
        Err(error) => Err(format!(
            "Failed to check Windows screen capture support: {error}"
        )),
    }
}

#[cfg(target_os = "macos")]
fn start_platform_capture(fps: u32) -> Result<PlatformCapturer, String> {
    use scap::capturer::{Capturer, Options};
    use scap::frame::FrameType;

    let options = Options {
        fps,
        show_cursor: true,
        show_highlight: false,
        output_type: FrameType::BGRAFrame,
        output_resolution: scap::capturer::Resolution::Captured,
        ..Default::default()
    };
    let mut capturer = Capturer::build(options).map_err(|error| format!("{error:?}"))?;
    capturer.start_capture();
    Ok(capturer)
}

#[cfg(target_os = "windows")]
fn start_platform_capture(_fps: u32) -> Result<PlatformCapturer, String> {
    crate::windows_capture_backend::Capturer::start()
}

#[cfg(target_os = "macos")]
fn stop_platform_capture(mut capturer: PlatformCapturer) -> Result<(), String> {
    capturer.stop_capture();
    Ok(())
}

#[cfg(target_os = "windows")]
fn stop_platform_capture(capturer: PlatformCapturer) -> Result<(), String> {
    capturer.stop()
}

/// Pull one BGRA frame from the macOS fork. Its `Frame` type is an alias for
/// `VideoFrame`, so there is no outer `Video` variant.
#[cfg(target_os = "macos")]
fn next_bgra_frame(capturer: &PlatformCapturer) -> Result<Option<(u32, u32, Vec<u8>)>, String> {
    use scap::frame::Frame as ScapFrame;

    match capturer.get_next_frame() {
        Ok(ScapFrame::BGRA(frame)) if frame.width > 0 && !frame.data.is_empty() => {
            Ok(Some((frame.width as u32, frame.height as u32, frame.data)))
        }
        Ok(_) => Ok(None),
        Err(error) => Err(format!("{error:?}")),
    }
}

/// Wait briefly for one BGRA frame from Windows.Graphics.Capture. Windows can
/// stop delivering frames while the desktop is static, so the adapter uses a
/// bounded receive that still lets this loop observe the stop flag promptly.
#[cfg(target_os = "windows")]
fn next_bgra_frame(capturer: &PlatformCapturer) -> Result<Option<(u32, u32, Vec<u8>)>, String> {
    match capturer.next_frame() {
        Ok(Some(frame)) if frame.width > 0 && frame.height > 0 && !frame.data.is_empty() => {
            Ok(Some((frame.width, frame.height, frame.data)))
        }
        Ok(Some(_)) => Ok(None),
        Ok(None) => Ok(None),
        Err(error) => Err(format!("{error:?}")),
    }
}

/// Locks the encoder's emitted-sample count to the wall clock: exactly one
/// sample per `interval_ms` slot since the first frame. The muxer assigns
/// every sample a fixed 1/fps duration, so the sample count IS the video
/// timeline — emitting more than one sample per slot stretches the video
/// (a 10.7s session once became a 16.4s file) and desyncs the wall-stamped
/// input events and perception observations from the picture.
///
/// Slot k covers `[base + k·interval, base + (k+1)·interval)`. Slot 0 is the
/// first real frame, written by the caller before constructing the pacer.
#[cfg_attr(not(any(target_os = "macos", target_os = "windows")), allow(dead_code))]
struct FramePacer {
    base_ts: i64,
    interval_ms: i64,
    /// Samples emitted so far — slots `0..emitted` are filled.
    emitted: i64,
}

#[cfg_attr(not(any(target_os = "macos", target_os = "windows")), allow(dead_code))]
impl FramePacer {
    fn new(first_frame_ts: i64, interval_ms: i64) -> Self {
        Self {
            base_ts: first_frame_ts,
            interval_ms: interval_ms.max(1),
            emitted: 1,
        }
    }

    fn slot(&self, t: i64) -> i64 {
        (t - self.base_ts).max(0) / self.interval_ms
    }

    /// How many fully-elapsed slots are still empty at wall time `now`. A slot
    /// still in progress is never repeated — a real frame for it may yet
    /// arrive (this grace is what prevents the old double-emit).
    fn pending_repeats(&self, now: i64) -> i64 {
        (self.slot(now) - self.emitted).max(0)
    }

    /// Timestamp the next repeat should carry (start of the first empty slot).
    fn next_slot_ts(&self) -> i64 {
        self.base_ts + self.emitted * self.interval_ms
    }

    /// Record one emitted sample (caller just wrote a repeat).
    fn mark_emitted(&mut self) {
        self.emitted += 1;
    }

    /// Whether a real frame at `ts` may be written: true when its slot is
    /// still empty (and claims it); false when the slot already has a sample —
    /// the frame is dropped to preserve cadence (the next slot's frame
    /// refreshes the content within one interval).
    fn admit_frame(&mut self, ts: i64) -> bool {
        if self.slot(ts) >= self.emitted {
            self.emitted += 1;
            true
        } else {
            false
        }
    }

    #[cfg(test)] // assertion seam — production reads go through the methods above
    fn emitted(&self) -> i64 {
        self.emitted
    }
}

/// Pick the encode resolution: fit `(w, h)` into a 1080p box (longer side <=
/// 1920, shorter <= 1080), preserving aspect, never upscaling, rounded to even
/// dimensions (I420 requirement). This is well within openh264's 4K hard limit
/// AND keeps software encode real-time — encoding native 4K/5K on the CPU only
/// manages a few fps, whereas 1080p is plenty to review a macro recording.
#[cfg(any(target_os = "macos", target_os = "windows"))]
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
    fn pacer_emits_one_sample_per_slot_at_slightly_slow_delivery() {
        // SCK delivering just under the target rate (~28fps vs 30) used to
        // double-emit: a timeout repeat AND the late real frame for the same
        // slot. With fixed-duration muxing that stretched a 10s session into
        // a ~15s video, desyncing wall-stamped events/observations.
        let mut p = FramePacer::new(0, 33);
        for ts in [36, 71, 107, 143] {
            assert_eq!(p.pending_repeats(ts), 0, "no repeat before frame at {ts}");
            assert!(p.admit_frame(ts), "frame at {ts} claims its own slot");
        }
        assert_eq!(p.emitted(), 5); // first frame + 4 admitted
    }

    #[test]
    fn pacer_fills_static_gaps_only_after_a_slot_fully_elapses() {
        let mut p = FramePacer::new(0, 33);
        assert_eq!(p.pending_repeats(34), 0, "slot 1 still in progress");
        assert_eq!(p.pending_repeats(67), 1, "slot 1 fully elapsed, unfilled");
        assert_eq!(p.next_slot_ts(), 33);
        p.mark_emitted();
        assert_eq!(p.pending_repeats(80), 0);
        assert_eq!(p.pending_repeats(101), 1);
    }

    #[test]
    fn pacer_backfills_a_long_gap_then_admits_the_frame() {
        let mut p = FramePacer::new(0, 33);
        let ts = 200; // slot 6; slots 1..=5 elapsed empty
        assert_eq!(p.pending_repeats(ts), 5);
        for _ in 0..5 {
            p.mark_emitted();
        }
        assert!(p.admit_frame(ts));
        assert_eq!(p.emitted(), 7);
    }

    #[test]
    fn pacer_drops_burst_frames_landing_in_filled_slots() {
        let mut p = FramePacer::new(0, 33);
        assert!(p.admit_frame(36)); // slot 1
        assert!(!p.admit_frame(46), "second frame in slot 1 is dropped");
        assert!(!p.admit_frame(56), "third frame in slot 1 is dropped");
        assert!(p.admit_frame(70)); // slot 2
        assert_eq!(p.emitted(), 3);
    }

    #[test]
    fn pacer_keeps_sample_count_locked_to_wall_clock_over_a_long_run() {
        // 10 wall seconds of 25fps delivery against a 30fps (33ms) grid must
        // yield ~wall/interval samples — NOT ~1.5×. Regression pin for the
        // stretched-video bug (16.4s video from a 10.7s session).
        let mut p = FramePacer::new(0, 33);
        let mut samples: i64 = 1; // the first frame
        let mut ts = 0;
        while ts < 10_000 {
            ts += 40; // 25fps delivery
                      // The encoder loop's recv_timeout also ticks between frames; the
                      // pacer must not let tick-repeats and admissions double-count.
            samples += p.pending_repeats(ts - 1);
            for _ in 0..p.pending_repeats(ts - 1) {
                p.mark_emitted();
            }
            if p.admit_frame(ts) {
                samples += 1;
            }
        }
        let expected = 10_000 / 33 + 1;
        assert!(
            (samples - expected).abs() <= 2,
            "samples {samples} should track wall slots {expected}"
        );
        assert_eq!(samples, p.emitted());
    }

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

    #[cfg(target_os = "macos")]
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
