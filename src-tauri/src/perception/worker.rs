//! Continuous perception worker. Owns a background thread that drains sampled
//! frames off the capture tee, runs the extractor, and accumulates full-frame
//! observations. The thread exits when the sender side (the acquisition thread)
//! drops OR when `finish()` raises the stop flag — the latter bounds shutdown
//! even if a wedged acquisition thread never drops its tee sender.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::RecvTimeoutError;
use std::sync::Arc;
use std::time::Duration;

use super::extractor::Extractor;
use super::{Observation, Region};

pub struct PerceptionWorker {
    handle: std::thread::JoinHandle<Vec<Observation>>,
    /// Raised by `finish()` so the loop exits within one `recv_timeout` tick
    /// even if the sender side never disconnects (wedged acquisition thread).
    stop: Arc<AtomicBool>,
}

impl PerceptionWorker {
    pub fn spawn(
        rx: std::sync::mpsc::Receiver<crate::capture::Frame>,
        start_ms: i64,
        extractor: Box<dyn Extractor + Send>,
    ) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let stop_in_thread = Arc::clone(&stop);
        let handle = std::thread::spawn(move || {
            let full = Region {
                x: 0.0,
                y: 0.0,
                w: 1.0,
                h: 1.0,
            };
            let mut out = Vec::new();
            // Normal exit: the acquisition thread drops the tee sender on capture
            // stop (Disconnected). Bounded fallback: capture.rs spawns acquisition
            // DETACHED and stop() joins only the encoder, so a wedged
            // get_next_frame() (display reconfig, permission revoked mid-stream)
            // can keep the sender alive forever — the stop flag check on each
            // timeout tick keeps finish() from hanging stop_recording.
            loop {
                match rx.recv_timeout(Duration::from_millis(250)) {
                    Ok(frame) => {
                        let started = std::time::Instant::now();
                        let rgba = crate::perception::convert::bgra_to_rgba(
                            frame.width,
                            frame.height,
                            &frame.data,
                        );
                        let result = extractor.extract(&rgba, &full);
                        crate::observability::log_info(
                            "perception",
                            "continuous_sample",
                            Some(serde_json::json!({
                                "durationMs": started.elapsed().as_secs_f64() * 1000.0,
                                "timestampMs": frame.timestamp_ms - start_ms,
                            })),
                        );
                        out.push(Observation {
                            target_id: None,
                            timestamp_ms: frame.timestamp_ms - start_ms,
                            result,
                        });
                    }
                    Err(RecvTimeoutError::Timeout) => {
                        if stop_in_thread.load(Ordering::Relaxed) {
                            break;
                        }
                    }
                    Err(RecvTimeoutError::Disconnected) => break,
                }
            }
            out
        });
        Self { handle, stop }
    }

    /// Call AFTER capture has stopped. The loop exits either when the sender
    /// side drops (normal path — the acquisition thread exits and its tee
    /// sender disconnects, promptly) or, if a wedged acquisition thread never
    /// drops it, when the stop flag raised here is seen on the next receive
    /// timeout tick — bounded by ≤250 ms plus any in-flight extraction.
    pub fn finish(self) -> Vec<Observation> {
        self.stop.store(true, Ordering::Relaxed);
        self.handle.join().unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::Frame;
    use crate::perception::{ObservationResult, Region};
    use render_core::frame::RgbaFrame;

    #[test]
    fn worker_converts_stamps_video_relative_and_finishes_on_disconnect() {
        struct CountSpans;
        impl Extractor for CountSpans {
            fn extract(&self, f: &RgbaFrame, _r: &Region) -> ObservationResult {
                // Prove BGRA→RGBA happened: input BGRA [1,2,3,255] → RGBA red channel 3.
                ObservationResult::Color {
                    rgb: [f.data[0], f.data[1], f.data[2]],
                    matched: true,
                }
            }
        }
        let (tx, rx) = std::sync::mpsc::sync_channel::<Frame>(4);
        let worker = PerceptionWorker::spawn(rx, 1_000, Box::new(CountSpans));
        tx.send(Frame {
            width: 1,
            height: 1,
            data: vec![1, 2, 3, 255],
            timestamp_ms: 1_500,
        })
        .unwrap();
        tx.send(Frame {
            width: 1,
            height: 1,
            data: vec![1, 2, 3, 255],
            timestamp_ms: 2_250,
        })
        .unwrap();
        drop(tx);
        let obs = worker.finish();
        assert_eq!(obs.len(), 2);
        assert_eq!(obs[0].timestamp_ms, 500);
        assert_eq!(obs[1].timestamp_ms, 1_250);
        assert!(obs.iter().all(|o| o.target_id.is_none()));
        match &obs[0].result {
            ObservationResult::Color { rgb, .. } => assert_eq!(*rgb, [3, 2, 1]),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn finish_returns_bounded_even_when_sender_still_alive() {
        // Pins the wedged-acquisition-thread fix: capture.rs spawns acquisition
        // DETACHED (stop() joins only the encoder), so if SCK wedges in
        // get_next_frame() the tee sender never drops. finish() must still
        // return within the bounded recv_timeout window instead of hanging
        // stop_recording forever.
        struct Noop;
        impl Extractor for Noop {
            fn extract(&self, _f: &RgbaFrame, _r: &Region) -> ObservationResult {
                ObservationResult::Color {
                    rgb: [0, 0, 0],
                    matched: true,
                }
            }
        }
        let (tx, rx) = std::sync::mpsc::sync_channel::<Frame>(4);
        let worker = PerceptionWorker::spawn(rx, 0, Box::new(Noop));
        tx.send(Frame {
            width: 1,
            height: 1,
            data: vec![0, 0, 0, 255],
            timestamp_ms: 100,
        })
        .unwrap();
        // Deliberately do NOT drop tx — simulate the wedged acquisition thread
        // holding the sender. finish() sets the stop flag, then joins; the
        // worker must exit on its next recv timeout.
        let obs = worker.finish();
        assert_eq!(obs.len(), 1, "in-flight frame still processed");
        assert_eq!(obs[0].timestamp_ms, 100);
        drop(tx);
    }
}
