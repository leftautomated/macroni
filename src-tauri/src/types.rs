//! Core types and data structures

use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::playback::PlaybackEngine;
use crate::recording_session::RecordingSession;

/// Represents a single input event captured during recording
#[derive(Debug, Clone, Serialize, Deserialize)]
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
}

fn default_playback_speed() -> f64 {
    1.0
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub video: Option<VideoMetadata>,
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
    pub fps: u32,
    pub quality: CaptureQuality,
    pub audio: bool,
}

impl Default for CaptureSettings {
    fn default() -> Self {
        Self {
            fps: 30,
            quality: CaptureQuality::Med,
            audio: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AppSettings {
    #[serde(default)]
    pub capture: CaptureSettings,
}
