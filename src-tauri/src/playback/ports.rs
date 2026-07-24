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
        #[cfg(target_os = "windows")]
        if let EventType::MouseMove { x, y } = event_type {
            return simulate_windows_mouse_move(x, y);
        }
        rdev::simulate(&event_type).map_err(|e| format!("{:?}", e))
    }
}

#[cfg(target_os = "windows")]
fn simulate_windows_mouse_move(x: f64, y: f64) -> Result<(), String> {
    use std::mem::size_of;

    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_MOUSE, MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_MOVE,
        MOUSEEVENTF_MOVE_NOCOALESCE, MOUSEEVENTF_VIRTUALDESK, MOUSEINPUT,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
        SM_YVIRTUALSCREEN,
    };

    // SAFETY: GetSystemMetrics has no pointer arguments and is safe to call
    // from the playback worker thread.
    let (left, top, width, height) = unsafe {
        (
            GetSystemMetrics(SM_XVIRTUALSCREEN),
            GetSystemMetrics(SM_YVIRTUALSCREEN),
            GetSystemMetrics(SM_CXVIRTUALSCREEN),
            GetSystemMetrics(SM_CYVIRTUALSCREEN),
        )
    };
    if width <= 1 || height <= 1 {
        return Err("Windows virtual desktop has invalid dimensions".to_string());
    }

    let normalized_x = (((x - f64::from(left)) * 65_535.0) / f64::from(width - 1))
        .round()
        .clamp(0.0, 65_535.0) as i32;
    let normalized_y = (((y - f64::from(top)) * 65_535.0) / f64::from(height - 1))
        .round()
        .clamp(0.0, 65_535.0) as i32;
    let input = INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx: normalized_x,
                dy: normalized_y,
                mouseData: 0,
                dwFlags: MOUSEEVENTF_MOVE
                    | MOUSEEVENTF_ABSOLUTE
                    | MOUSEEVENTF_VIRTUALDESK
                    | MOUSEEVENTF_MOVE_NOCOALESCE,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };

    // SAFETY: `input` is a fully initialized INPUT value and remains alive for
    // the duration of the call; the element count and struct size are exact.
    let sent = unsafe { SendInput(1, &input, size_of::<INPUT>() as i32) };
    if sent == 1 {
        Ok(())
    } else {
        Err("Windows SendInput rejected a cursor movement".to_string())
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
