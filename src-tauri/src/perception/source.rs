//! Frame access for perception. Named PerceptionSource — render-core already
//! has an index-based `FrameSource`; this one is timestamp-based.

use std::path::Path;

use render_core::decode::{Mp4FrameSource, RgbaFrame};

#[allow(dead_code)] // consumed by Task 6 (commands)
pub trait PerceptionSource {
    /// One frame as RGBA8. Live sources ignore `timestamp_ms` (grab "now").
    fn frame_at(&mut self, timestamp_ms: i64) -> Result<RgbaFrame, String>;
    fn dimensions(&self) -> (u32, u32);
}

/// CFR mapping: the encoder holds cadence via `repeat_last`, so
/// `round(ms × fps / 1000)` clamped to the last frame is exact. If encoding
/// ever becomes VFR this must switch to per-sample PTS.
pub fn frame_index_for_ms(timestamp_ms: i64, fps: u32, frame_count: usize) -> usize {
    if frame_count == 0 || fps == 0 {
        return 0;
    }
    let idx = ((timestamp_ms.max(0) * fps as i64 + 500) / 1000) as usize;
    idx.min(frame_count - 1)
}

#[allow(dead_code)] // consumed by Task 6 (commands)
pub struct RecordingSource {
    src: Mp4FrameSource,
    fps: u32,
}

impl RecordingSource {
    #[allow(dead_code)] // consumed by Task 6 (commands)
    pub fn open(path: &Path, fps: u32) -> Result<Self, String> {
        Ok(Self {
            src: Mp4FrameSource::open(path).map_err(|e| e.to_string())?,
            fps,
        })
    }
}

impl PerceptionSource for RecordingSource {
    fn frame_at(&mut self, timestamp_ms: i64) -> Result<RgbaFrame, String> {
        let idx = frame_index_for_ms(timestamp_ms, self.fps, self.src.frame_count());
        self.src.decode_frame(idx).map_err(|e| e.to_string())
    }
    fn dimensions(&self) -> (u32, u32) {
        self.src.dimensions()
    }
}

#[allow(dead_code)] // consumed by Task 6 (commands)
pub struct LiveSource {
    dims: (u32, u32),
}

impl LiveSource {
    #[allow(dead_code)] // consumed by Task 6 (commands)
    pub fn new() -> Self {
        Self { dims: (0, 0) }
    }
}

#[cfg(target_os = "windows")]
impl PerceptionSource for LiveSource {
    fn frame_at(&mut self, _timestamp_ms: i64) -> Result<RgbaFrame, String> {
        Err("live-capture-unsupported".to_string())
    }
    fn dimensions(&self) -> (u32, u32) {
        self.dims
    }
}

#[cfg(not(target_os = "windows"))]
impl PerceptionSource for LiveSource {
    fn frame_at(&mut self, _timestamp_ms: i64) -> Result<RgbaFrame, String> {
        use scap::capturer::{Capturer, Options, Resolution};
        use scap::frame::{Frame as ScapFrame, FrameType};
        if !scap::is_supported() {
            return Err("Screen capture is not supported on this platform".to_string());
        }
        if !scap::has_permission() {
            return Err("permission-denied".to_string());
        }
        let opts = Options {
            fps: 1,
            show_cursor: true,
            show_highlight: false,
            output_type: FrameType::BGRAFrame,
            output_resolution: Resolution::Captured,
            ..Default::default()
        };
        let mut capturer = Capturer::build(opts).map_err(|e| format!("{e:?}"))?;
        capturer.start_capture();
        let mut result = Err("no frame delivered".to_string());
        for _ in 0..60 {
            match capturer.get_next_frame() {
                Ok(ScapFrame::BGRA(f)) if f.width > 0 && !f.data.is_empty() => {
                    let (w, h) = (f.width as u32, f.height as u32);
                    self.dims = (w, h);
                    result = Ok(super::convert::bgra_to_rgba(w, h, &f.data));
                    break;
                }
                Ok(_) => continue, // idle/audio frame
                Err(e) => {
                    result = Err(format!("{e:?}"));
                    break;
                }
            }
        }
        capturer.stop_capture();
        result
    }
    fn dimensions(&self) -> (u32, u32) {
        self.dims
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_index_rounds_and_clamps() {
        assert_eq!(frame_index_for_ms(0, 30, 100), 0);
        assert_eq!(frame_index_for_ms(33, 30, 100), 1); // 0.99 → round 1
        assert_eq!(frame_index_for_ms(50, 30, 100), 2); // 1.5 → round 2 (round half up)
        assert_eq!(frame_index_for_ms(1_000, 30, 100), 30);
        assert_eq!(frame_index_for_ms(999_999, 30, 100), 99); // clamp to last frame
        assert_eq!(frame_index_for_ms(-5, 30, 100), 0);
        assert_eq!(frame_index_for_ms(100, 0, 100), 0); // fps guard
        assert_eq!(frame_index_for_ms(100, 30, 0), 0); // empty guard
    }
}
