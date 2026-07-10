//! Core types and data structures

use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::playback::PlaybackEngine;
use crate::recording_session::RecordingSession;

/// Represents a single input event captured during recording
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "PascalCase")]
pub enum InputEvent {
    KeyPress {
        key: String,
        timestamp: i64,
    },
    KeyRelease {
        key: String,
        timestamp: i64,
    },
    KeyCombo {
        char: String,
        key: String,
        modifiers: Vec<String>,
        timestamp: i64,
    },
    ButtonPress {
        button: String,
        x: f64,
        y: f64,
        timestamp: i64,
    },
    ButtonRelease {
        button: String,
        x: f64,
        y: f64,
        timestamp: i64,
    },
    MouseMove {
        x: f64,
        y: f64,
        timestamp: i64,
    },
    Scroll {
        delta_x: i64,
        delta_y: i64,
        timestamp: i64,
    },
    /// A macOS Space / fullscreen-app switch (3-finger swipe, ⌃arrows, …),
    /// captured semantically — the gesture itself is not observable.
    SpaceSwitch {
        direction: String, // "left" | "right"
        count: u32,        // hops — a fast multi-Space swipe records 2+
        timestamp: i64,
    },
}

fn default_playback_speed() -> f64 {
    1.0
}

/// Units of `InputEvent::Scroll` deltas in a saved recording.
///
/// Recordings made before the rdev fork switched capture to pixel-precision
/// deltas stored coarse line units; replay emits pixels, so those recordings
/// scrolled ~10x weaker. The field is absent in old files, so it defaults to
/// `Lines`; the store normalizes those to pixels on load.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum ScrollUnit {
    #[default]
    Lines,
    Pixels,
}

/// Approximate pixels per scroll line on macOS, used to upgrade legacy
/// line-unit recordings to pixel units.
pub const SCROLL_LINE_TO_PIXELS: i64 = 10;

impl Recording {
    /// Upgrade legacy line-unit scroll deltas to pixel units in place.
    /// Idempotent: pixel-unit recordings are left untouched.
    ///
    /// The line→pixel mismatch only exists on macOS — the rdev fork that
    /// switched capture to pixel-precision deltas only changed macOS
    /// `listen`. On other platforms legacy recordings already replay at the
    /// correct magnitude, so multiplying deltas there would corrupt them.
    /// The `scroll_unit` marker is still normalized to `Pixels` everywhere so
    /// the migration only ever runs once, regardless of platform.
    pub fn normalize_scroll_units(&mut self) {
        if self.scroll_unit == ScrollUnit::Pixels {
            return;
        }
        #[cfg(target_os = "macos")]
        {
            for event in &mut self.events {
                if let InputEvent::Scroll {
                    delta_x, delta_y, ..
                } = event
                {
                    *delta_x *= SCROLL_LINE_TO_PIXELS;
                    *delta_y *= SCROLL_LINE_TO_PIXELS;
                }
            }
        }
        self.scroll_unit = ScrollUnit::Pixels;
    }
}

/// Metadata describing a screen recording video file associated with a Recording.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VideoMetadata {
    pub path: String,
    pub start_ms: i64,
    pub duration_ms: i64,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub has_audio: bool,
}

/// A saved recording containing a sequence of input events
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Recording {
    pub id: String,
    pub name: String,
    pub events: Vec<InputEvent>,
    pub created_at: i64,
    #[serde(default = "default_playback_speed")]
    pub playback_speed: f64,
    /// Units of scroll deltas in `events`. Old files lack the field and
    /// default to `Lines`; see `normalize_scroll_units`.
    #[serde(default)]
    pub scroll_unit: ScrollUnit,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub video: Option<VideoMetadata>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub targets: Vec<crate::perception::Target>,
}

/// Shared application state. Two cohesive halves:
///   - `session`: the recording-side state machine (idle / active).
///   - `engine`: the playback-side state machine.
///
/// Modifier/button/mouse-position state for the input listener lives inside
/// `event_capture::EventCapture` on the listener thread itself.
pub struct RecordingState {
    pub session: Arc<RecordingSession>,
    pub engine: Arc<PlaybackEngine>,
}

impl Default for RecordingState {
    fn default() -> Self {
        Self {
            session: Arc::new(RecordingSession::new()),
            engine: Arc::new(PlaybackEngine::new()),
        }
    }
}

/// Trait for extracting timestamps from input events
pub trait InputEventTimestamp {
    fn timestamp(&self) -> i64;
}

impl InputEventTimestamp for InputEvent {
    fn timestamp(&self) -> i64 {
        match self {
            InputEvent::KeyPress { timestamp, .. } => *timestamp,
            InputEvent::KeyRelease { timestamp, .. } => *timestamp,
            InputEvent::KeyCombo { timestamp, .. } => *timestamp,
            InputEvent::ButtonPress { timestamp, .. } => *timestamp,
            InputEvent::ButtonRelease { timestamp, .. } => *timestamp,
            InputEvent::MouseMove { timestamp, .. } => *timestamp,
            InputEvent::Scroll { timestamp, .. } => *timestamp,
            InputEvent::SpaceSwitch { timestamp, .. } => *timestamp,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CaptureQuality {
    Low,
    Med,
    High,
}

impl CaptureQuality {
    #[allow(dead_code)]
    pub fn crf(&self) -> u8 {
        match self {
            CaptureQuality::Low => 32,
            CaptureQuality::Med => 28,
            CaptureQuality::High => 23,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CaptureSettings {
    #[serde(default = "default_capture_video")]
    pub video: bool,
    #[serde(default = "default_capture_fps")]
    pub fps: u32,
    #[serde(default = "default_capture_quality")]
    pub quality: CaptureQuality,
    #[serde(default = "default_capture_audio")]
    pub audio: bool,
}

fn default_capture_video() -> bool {
    cfg!(target_os = "macos")
}

fn default_capture_fps() -> u32 {
    30
}

fn default_capture_quality() -> CaptureQuality {
    CaptureQuality::Med
}

fn default_capture_audio() -> bool {
    true
}

impl Default for CaptureSettings {
    fn default() -> Self {
        Self {
            video: default_capture_video(),
            fps: 30,
            quality: CaptureQuality::Med,
            audio: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PerceptionSettings {
    /// Continuous full-frame OCR during recording. Off by default: it
    /// transcribes everything visible on screen into a plaintext sidecar.
    #[serde(default)]
    pub continuous_ocr: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AppSettings {
    #[serde(default)]
    pub capture: CaptureSettings,
    #[serde(default)]
    pub perception: PerceptionSettings,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn space_switch_serde_round_trips_with_house_tagging() {
        let ev = InputEvent::SpaceSwitch {
            direction: "right".into(),
            count: 2,
            timestamp: 1500,
        };
        let json = serde_json::to_string(&ev).unwrap();
        assert!(json.contains("\"type\":\"SpaceSwitch\""), "{json}");
        let back: InputEvent = serde_json::from_str(&json).unwrap();
        assert_eq!(back.timestamp(), 1500);
        assert!(matches!(back, InputEvent::SpaceSwitch { count: 2, .. }));
    }

    #[test]
    fn legacy_event_json_still_loads() {
        let json = r#"{"type":"KeyPress","key":"A","timestamp":1}"#;
        let ev: InputEvent = serde_json::from_str(json).unwrap();
        assert_eq!(ev.timestamp(), 1);
    }
}
