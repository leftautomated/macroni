//! Core types and data structures

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use rdev::{Key, Button};

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

/// Shared application state for recording and playback
pub struct RecordingState {
    pub is_recording: Arc<Mutex<bool>>,
    pub current_events: Arc<Mutex<Vec<InputEvent>>>,
    pub last_mouse_position: Arc<Mutex<Option<(f64, f64)>>>,
    pub pressed_modifiers: Arc<Mutex<HashSet<Key>>>,
    pub pressed_buttons: Arc<Mutex<HashSet<Button>>>,
    pub is_playing: Arc<Mutex<bool>>,
    pub playback_position: Arc<Mutex<Option<usize>>>,
    pub loop_count: Arc<Mutex<usize>>,
}

impl Default for RecordingState {
    fn default() -> Self {
        Self {
            is_recording: Arc::new(Mutex::new(false)),
            current_events: Arc::new(Mutex::new(Vec::new())),
            last_mouse_position: Arc::new(Mutex::new(None)),
            pressed_modifiers: Arc::new(Mutex::new(HashSet::new())),
            pressed_buttons: Arc::new(Mutex::new(HashSet::new())),
            is_playing: Arc::new(Mutex::new(false)),
            playback_position: Arc::new(Mutex::new(None)),
            loop_count: Arc::new(Mutex::new(0)),
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
        Self { fps: 30, quality: CaptureQuality::Med, audio: true }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AppSettings {
    #[serde(default)]
    pub capture: CaptureSettings,
}

