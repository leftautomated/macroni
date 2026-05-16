//! Ports for playback I/O: input simulation and UI event emission.

use rdev::EventType;
use tauri::{AppHandle, Emitter as _};

pub trait Simulator: Send + 'static {
    fn simulate(&self, event_type: EventType) -> Result<(), String>;
}

pub trait Emitter: Send + 'static {
    fn emit_position(&self, index: usize);
    fn emit_loop_restart(&self);
    fn emit_complete(&self);
}

/// Production simulator backed by `rdev::simulate`.
pub struct RdevSimulator;

impl Simulator for RdevSimulator {
    fn simulate(&self, event_type: EventType) -> Result<(), String> {
        rdev::simulate(&event_type).map_err(|e| format!("{:?}", e))
    }
}

/// Production emitter that broadcasts playback events to the frontend via Tauri.
pub struct TauriEmitter {
    app: AppHandle,
}

impl TauriEmitter {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl Emitter for TauriEmitter {
    fn emit_position(&self, index: usize) {
        let _ = self.app.emit("playback-position", index);
    }
    fn emit_loop_restart(&self) {
        let _ = self.app.emit("playback-loop-restart", ());
    }
    fn emit_complete(&self) {
        let _ = self.app.emit("playback-complete", ());
    }
}
