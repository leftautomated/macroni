use std::sync::{Arc, Mutex};
use std::sync::mpsc::channel;
use std::collections::HashSet;
use std::thread;
use std::time::Duration;
use rdev::{listen, simulate, Event, EventType, Key, Button};
use serde::{Deserialize, Serialize};
use chrono::Utc;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use tauri_plugin_global_shortcut::GlobalShortcutExt;

#[cfg(target_os = "macos")]
use tauri_nspanel::{tauri_panel, ManagerExt, WebviewWindowExt};

#[cfg(target_os = "macos")]
tauri_panel! {
    panel!(MacroPanel {
        config: {
            can_become_key_window: false, // Don't require focus to receive clicks
            is_floating_panel: true
        }
    })
}

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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Recording {
    id: String,
    name: String,
    events: Vec<InputEvent>,
    created_at: i64,
}

pub struct RecordingState {
    is_recording: Arc<Mutex<bool>>,
    current_events: Arc<Mutex<Vec<InputEvent>>>,
    last_mouse_position: Arc<Mutex<Option<(f64, f64)>>>,
    pressed_modifiers: Arc<Mutex<HashSet<Key>>>,
    pressed_buttons: Arc<Mutex<HashSet<Button>>>,
    is_playing: Arc<Mutex<bool>>,
    playback_position: Arc<Mutex<Option<usize>>>,
    loop_count: Arc<Mutex<usize>>,
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

fn key_to_string(key: Key) -> String {
    match key {
        Key::Alt => "Alt".to_string(),
        Key::AltGr => "AltGr".to_string(),
        Key::Backspace => "Backspace".to_string(),
        Key::CapsLock => "CapsLock".to_string(),
        Key::ControlLeft => "Ctrl".to_string(),
        Key::ControlRight => "Ctrl".to_string(),
        Key::Delete => "Delete".to_string(),
        Key::DownArrow => "↓".to_string(),
        Key::End => "End".to_string(),
        Key::Escape => "Esc".to_string(),
        Key::F1 => "F1".to_string(),
        Key::F2 => "F2".to_string(),
        Key::F3 => "F3".to_string(),
        Key::F4 => "F4".to_string(),
        Key::F5 => "F5".to_string(),
        Key::F6 => "F6".to_string(),
        Key::F7 => "F7".to_string(),
        Key::F8 => "F8".to_string(),
        Key::F9 => "F9".to_string(),
        Key::F10 => "F10".to_string(),
        Key::F11 => "F11".to_string(),
        Key::F12 => "F12".to_string(),
        Key::Home => "Home".to_string(),
        Key::LeftArrow => "←".to_string(),
        Key::MetaLeft => "Cmd".to_string(),
        Key::MetaRight => "Cmd".to_string(),
        Key::PageDown => "PgDn".to_string(),
        Key::PageUp => "PgUp".to_string(),
        Key::Return => "Enter".to_string(),
        Key::RightArrow => "→".to_string(),
        Key::ShiftLeft => "Shift".to_string(),
        Key::ShiftRight => "Shift".to_string(),
        Key::Space => "Space".to_string(),
        Key::Tab => "Tab".to_string(),
        Key::UpArrow => "↑".to_string(),
        Key::PrintScreen => "PrtSc".to_string(),
        Key::ScrollLock => "ScrLk".to_string(),
        Key::Pause => "Pause".to_string(),
        Key::NumLock => "NumLk".to_string(),
        Key::BackQuote => "`".to_string(),
        Key::Num1 => "1".to_string(),
        Key::Num2 => "2".to_string(),
        Key::Num3 => "3".to_string(),
        Key::Num4 => "4".to_string(),
        Key::Num5 => "5".to_string(),
        Key::Num6 => "6".to_string(),
        Key::Num7 => "7".to_string(),
        Key::Num8 => "8".to_string(),
        Key::Num9 => "9".to_string(),
        Key::Num0 => "0".to_string(),
        Key::Minus => "-".to_string(),
        Key::Equal => "=".to_string(),
        Key::KeyQ => "Q".to_string(),
        Key::KeyW => "W".to_string(),
        Key::KeyE => "E".to_string(),
        Key::KeyR => "R".to_string(),
        Key::KeyT => "T".to_string(),
        Key::KeyY => "Y".to_string(),
        Key::KeyU => "U".to_string(),
        Key::KeyI => "I".to_string(),
        Key::KeyO => "O".to_string(),
        Key::KeyP => "P".to_string(),
        Key::LeftBracket => "[".to_string(),
        Key::RightBracket => "]".to_string(),
        Key::KeyA => "A".to_string(),
        Key::KeyS => "S".to_string(),
        Key::KeyD => "D".to_string(),
        Key::KeyF => "F".to_string(),
        Key::KeyG => "G".to_string(),
        Key::KeyH => "H".to_string(),
        Key::KeyJ => "J".to_string(),
        Key::KeyK => "K".to_string(),
        Key::KeyL => "L".to_string(),
        Key::SemiColon => ";".to_string(),
        Key::Quote => "'".to_string(),
        Key::BackSlash => "\\".to_string(),
        Key::IntlBackslash => "\\".to_string(),
        Key::KeyZ => "Z".to_string(),
        Key::KeyX => "X".to_string(),
        Key::KeyC => "C".to_string(),
        Key::KeyV => "V".to_string(),
        Key::KeyB => "B".to_string(),
        Key::KeyN => "N".to_string(),
        Key::KeyM => "M".to_string(),
        Key::Comma => ",".to_string(),
        Key::Dot => ".".to_string(),
        Key::Slash => "/".to_string(),
        Key::Insert => "Ins".to_string(),
        Key::KpReturn => "Enter".to_string(),
        Key::KpMinus => "-".to_string(),
        Key::KpPlus => "+".to_string(),
        Key::KpMultiply => "*".to_string(),
        Key::KpDivide => "/".to_string(),
        Key::Kp0 => "0".to_string(),
        Key::Kp1 => "1".to_string(),
        Key::Kp2 => "2".to_string(),
        Key::Kp3 => "3".to_string(),
        Key::Kp4 => "4".to_string(),
        Key::Kp5 => "5".to_string(),
        Key::Kp6 => "6".to_string(),
        Key::Kp7 => "7".to_string(),
        Key::Kp8 => "8".to_string(),
        Key::Kp9 => "9".to_string(),
        _ => format!("{:?}", key),
    }
}

fn button_to_string(button: Button) -> String {
    match button {
        Button::Left => "Left".to_string(),
        Button::Right => "Right".to_string(),
        Button::Middle => "Middle".to_string(),
        Button::Unknown(code) => format!("Unknown({})", code),
    }
}

fn string_to_key(key_str: &str) -> Option<Key> {
    match key_str {
        "Alt" => Some(Key::Alt),
        "AltGr" => Some(Key::AltGr),
        "Backspace" => Some(Key::Backspace),
        "CapsLock" => Some(Key::CapsLock),
        "Ctrl" => Some(Key::ControlLeft), // Default to left
        "Delete" => Some(Key::Delete),
        "↓" => Some(Key::DownArrow),
        "End" => Some(Key::End),
        "Esc" => Some(Key::Escape),
        "F1" => Some(Key::F1),
        "F2" => Some(Key::F2),
        "F3" => Some(Key::F3),
        "F4" => Some(Key::F4),
        "F5" => Some(Key::F5),
        "F6" => Some(Key::F6),
        "F7" => Some(Key::F7),
        "F8" => Some(Key::F8),
        "F9" => Some(Key::F9),
        "F10" => Some(Key::F10),
        "F11" => Some(Key::F11),
        "F12" => Some(Key::F12),
        "Home" => Some(Key::Home),
        "←" => Some(Key::LeftArrow),
        "Cmd" => Some(Key::MetaLeft), // Default to left
        "PgDn" => Some(Key::PageDown),
        "PgUp" => Some(Key::PageUp),
        "Enter" => Some(Key::Return),
        "→" => Some(Key::RightArrow),
        "Shift" => Some(Key::ShiftLeft), // Default to left
        "Space" => Some(Key::Space),
        "Tab" => Some(Key::Tab),
        "↑" => Some(Key::UpArrow),
        "PrtSc" => Some(Key::PrintScreen),
        "ScrLk" => Some(Key::ScrollLock),
        "Pause" => Some(Key::Pause),
        "NumLk" => Some(Key::NumLock),
        "`" => Some(Key::BackQuote),
        "1" => Some(Key::Num1),
        "2" => Some(Key::Num2),
        "3" => Some(Key::Num3),
        "4" => Some(Key::Num4),
        "5" => Some(Key::Num5),
        "6" => Some(Key::Num6),
        "7" => Some(Key::Num7),
        "8" => Some(Key::Num8),
        "9" => Some(Key::Num9),
        "0" => Some(Key::Num0),
        "-" => Some(Key::Minus),
        "=" => Some(Key::Equal),
        "Q" => Some(Key::KeyQ),
        "W" => Some(Key::KeyW),
        "E" => Some(Key::KeyE),
        "R" => Some(Key::KeyR),
        "T" => Some(Key::KeyT),
        "Y" => Some(Key::KeyY),
        "U" => Some(Key::KeyU),
        "I" => Some(Key::KeyI),
        "O" => Some(Key::KeyO),
        "P" => Some(Key::KeyP),
        "[" => Some(Key::LeftBracket),
        "]" => Some(Key::RightBracket),
        "A" => Some(Key::KeyA),
        "S" => Some(Key::KeyS),
        "D" => Some(Key::KeyD),
        "F" => Some(Key::KeyF),
        "G" => Some(Key::KeyG),
        "H" => Some(Key::KeyH),
        "J" => Some(Key::KeyJ),
        "K" => Some(Key::KeyK),
        "L" => Some(Key::KeyL),
        ";" => Some(Key::SemiColon),
        "'" => Some(Key::Quote),
        "\\" => Some(Key::BackSlash),
        "Z" => Some(Key::KeyZ),
        "X" => Some(Key::KeyX),
        "C" => Some(Key::KeyC),
        "V" => Some(Key::KeyV),
        "B" => Some(Key::KeyB),
        "N" => Some(Key::KeyN),
        "M" => Some(Key::KeyM),
        "," => Some(Key::Comma),
        "." => Some(Key::Dot),
        "/" => Some(Key::Slash),
        "Ins" => Some(Key::Insert),
        _ => None,
    }
}

fn string_to_button(button_str: &str) -> Option<Button> {
    match button_str {
        "Left" => Some(Button::Left),
        "Right" => Some(Button::Right),
        "Middle" => Some(Button::Middle),
        _ => None,
    }
}

fn is_modifier_key(key: Key) -> bool {
    matches!(
        key,
        Key::ShiftLeft
            | Key::ShiftRight
            | Key::ControlLeft
            | Key::ControlRight
            | Key::Alt
            | Key::AltGr
            | Key::MetaLeft
            | Key::MetaRight
    )
}

fn get_character_with_modifiers(key: Key, modifiers: &HashSet<Key>) -> Option<String> {
    if modifiers.is_empty() {
        return None;
    }

    let has_shift = modifiers.contains(&Key::ShiftLeft) || modifiers.contains(&Key::ShiftRight);
    let has_ctrl = modifiers.contains(&Key::ControlLeft) || modifiers.contains(&Key::ControlRight);
    let has_alt = modifiers.contains(&Key::Alt) || modifiers.contains(&Key::AltGr);
    let has_cmd = modifiers.contains(&Key::MetaLeft) || modifiers.contains(&Key::MetaRight);

    // Handle Shift combinations (most common)
    if has_shift && !has_ctrl && !has_alt && !has_cmd {
        return match key {
            Key::Num1 => Some("!".to_string()),
            Key::Num2 => Some("@".to_string()),
            Key::Num3 => Some("#".to_string()),
            Key::Num4 => Some("$".to_string()),
            Key::Num5 => Some("%".to_string()),
            Key::Num6 => Some("^".to_string()),
            Key::Num7 => Some("&".to_string()),
            Key::Num8 => Some("*".to_string()),
            Key::Num9 => Some("(".to_string()),
            Key::Num0 => Some(")".to_string()),
            Key::Minus => Some("_".to_string()),
            Key::Equal => Some("+".to_string()),
            Key::LeftBracket => Some("{".to_string()),
            Key::RightBracket => Some("}".to_string()),
            Key::BackSlash | Key::IntlBackslash => Some("|".to_string()),
            Key::SemiColon => Some(":".to_string()),
            Key::Quote => Some("\"".to_string()),
            Key::BackQuote => Some("~".to_string()),
            Key::Comma => Some("<".to_string()),
            Key::Dot => Some(">".to_string()),
            Key::Slash => Some("?".to_string()),
            Key::KeyA => Some("A".to_string()),
            Key::KeyB => Some("B".to_string()),
            Key::KeyC => Some("C".to_string()),
            Key::KeyD => Some("D".to_string()),
            Key::KeyE => Some("E".to_string()),
            Key::KeyF => Some("F".to_string()),
            Key::KeyG => Some("G".to_string()),
            Key::KeyH => Some("H".to_string()),
            Key::KeyI => Some("I".to_string()),
            Key::KeyJ => Some("J".to_string()),
            Key::KeyK => Some("K".to_string()),
            Key::KeyL => Some("L".to_string()),
            Key::KeyM => Some("M".to_string()),
            Key::KeyN => Some("N".to_string()),
            Key::KeyO => Some("O".to_string()),
            Key::KeyP => Some("P".to_string()),
            Key::KeyQ => Some("Q".to_string()),
            Key::KeyR => Some("R".to_string()),
            Key::KeyS => Some("S".to_string()),
            Key::KeyT => Some("T".to_string()),
            Key::KeyU => Some("U".to_string()),
            Key::KeyV => Some("V".to_string()),
            Key::KeyW => Some("W".to_string()),
            Key::KeyX => Some("X".to_string()),
            Key::KeyY => Some("Y".to_string()),
            Key::KeyZ => Some("Z".to_string()),
            _ => None,
        };
    }

    // Handle Ctrl combinations
    if has_ctrl && !has_shift && !has_alt && !has_cmd {
        return match key {
            Key::KeyA => Some("Ctrl+A".to_string()),
            Key::KeyB => Some("Ctrl+B".to_string()),
            Key::KeyC => Some("Ctrl+C".to_string()),
            Key::KeyD => Some("Ctrl+D".to_string()),
            Key::KeyE => Some("Ctrl+E".to_string()),
            Key::KeyF => Some("Ctrl+F".to_string()),
            Key::KeyG => Some("Ctrl+G".to_string()),
            Key::KeyH => Some("Ctrl+H".to_string()),
            Key::KeyI => Some("Ctrl+I".to_string()),
            Key::KeyJ => Some("Ctrl+J".to_string()),
            Key::KeyK => Some("Ctrl+K".to_string()),
            Key::KeyL => Some("Ctrl+L".to_string()),
            Key::KeyM => Some("Ctrl+M".to_string()),
            Key::KeyN => Some("Ctrl+N".to_string()),
            Key::KeyO => Some("Ctrl+O".to_string()),
            Key::KeyP => Some("Ctrl+P".to_string()),
            Key::KeyQ => Some("Ctrl+Q".to_string()),
            Key::KeyR => Some("Ctrl+R".to_string()),
            Key::KeyS => Some("Ctrl+S".to_string()),
            Key::KeyT => Some("Ctrl+T".to_string()),
            Key::KeyU => Some("Ctrl+U".to_string()),
            Key::KeyV => Some("Ctrl+V".to_string()),
            Key::KeyW => Some("Ctrl+W".to_string()),
            Key::KeyX => Some("Ctrl+X".to_string()),
            Key::KeyY => Some("Ctrl+Y".to_string()),
            Key::KeyZ => Some("Ctrl+Z".to_string()),
            _ => None,
        };
    }

    // Handle Alt combinations
    if has_alt && !has_shift && !has_ctrl && !has_cmd {
        return match key {
            Key::KeyA => Some("Alt+A".to_string()),
            Key::KeyB => Some("Alt+B".to_string()),
            Key::KeyC => Some("Alt+C".to_string()),
            Key::KeyD => Some("Alt+D".to_string()),
            Key::KeyE => Some("Alt+E".to_string()),
            Key::KeyF => Some("Alt+F".to_string()),
            Key::KeyG => Some("Alt+G".to_string()),
            Key::KeyH => Some("Alt+H".to_string()),
            Key::KeyI => Some("Alt+I".to_string()),
            Key::KeyJ => Some("Alt+J".to_string()),
            Key::KeyK => Some("Alt+K".to_string()),
            Key::KeyL => Some("Alt+L".to_string()),
            Key::KeyM => Some("Alt+M".to_string()),
            Key::KeyN => Some("Alt+N".to_string()),
            Key::KeyO => Some("Alt+O".to_string()),
            Key::KeyP => Some("Alt+P".to_string()),
            Key::KeyQ => Some("Alt+Q".to_string()),
            Key::KeyR => Some("Alt+R".to_string()),
            Key::KeyS => Some("Alt+S".to_string()),
            Key::KeyT => Some("Alt+T".to_string()),
            Key::KeyU => Some("Alt+U".to_string()),
            Key::KeyV => Some("Alt+V".to_string()),
            Key::KeyW => Some("Alt+W".to_string()),
            Key::KeyX => Some("Alt+X".to_string()),
            Key::KeyY => Some("Alt+Y".to_string()),
            Key::KeyZ => Some("Alt+Z".to_string()),
            _ => None,
        };
    }

    // Handle Cmd combinations (macOS)
    if has_cmd && !has_shift && !has_ctrl && !has_alt {
        return match key {
            Key::KeyA => Some("Cmd+A".to_string()),
            Key::KeyB => Some("Cmd+B".to_string()),
            Key::KeyC => Some("Cmd+C".to_string()),
            Key::KeyD => Some("Cmd+D".to_string()),
            Key::KeyE => Some("Cmd+E".to_string()),
            Key::KeyF => Some("Cmd+F".to_string()),
            Key::KeyG => Some("Cmd+G".to_string()),
            Key::KeyH => Some("Cmd+H".to_string()),
            Key::KeyI => Some("Cmd+I".to_string()),
            Key::KeyJ => Some("Cmd+J".to_string()),
            Key::KeyK => Some("Cmd+K".to_string()),
            Key::KeyL => Some("Cmd+L".to_string()),
            Key::KeyM => Some("Cmd+M".to_string()),
            Key::KeyN => Some("Cmd+N".to_string()),
            Key::KeyO => Some("Cmd+O".to_string()),
            Key::KeyP => Some("Cmd+P".to_string()),
            Key::KeyQ => Some("Cmd+Q".to_string()),
            Key::KeyR => Some("Cmd+R".to_string()),
            Key::KeyS => Some("Cmd+S".to_string()),
            Key::KeyT => Some("Cmd+T".to_string()),
            Key::KeyU => Some("Cmd+U".to_string()),
            Key::KeyV => Some("Cmd+V".to_string()),
            Key::KeyW => Some("Cmd+W".to_string()),
            Key::KeyX => Some("Cmd+X".to_string()),
            Key::KeyY => Some("Cmd+Y".to_string()),
            Key::KeyZ => Some("Cmd+Z".to_string()),
            _ => None,
        };
    }

    // Handle multiple modifier combinations
    let mut modifier_names = Vec::new();
    if has_shift {
        modifier_names.push("Shift".to_string());
    }
    if has_ctrl {
        modifier_names.push("Ctrl".to_string());
    }
    if has_alt {
        modifier_names.push("Alt".to_string());
    }
    if has_cmd {
        modifier_names.push("Cmd".to_string());
    }

    if modifier_names.len() > 1 {
        let key_str = key_to_string(key);
        Some(format!("{}+{}", modifier_names.join("+"), key_str))
    } else {
        None
    }
}

#[tauri::command]
fn start_recording(state: State<RecordingState>) -> Result<(), String> {
    let mut is_recording = state.is_recording.lock().map_err(|e| e.to_string())?;
    
    if *is_recording {
        return Err("Already recording".to_string());
    }
    
    *is_recording = true;
    drop(is_recording);
    
    let mut events = state.current_events.lock().map_err(|e| e.to_string())?;
    events.clear();
    
    let mut modifiers = state.pressed_modifiers.lock().map_err(|e| e.to_string())?;
    modifiers.clear();
    
    let mut buttons = state.pressed_buttons.lock().map_err(|e| e.to_string())?;
    buttons.clear();
    
    Ok(())
}

#[tauri::command]
fn stop_recording(state: State<RecordingState>) -> Result<Vec<InputEvent>, String> {
    let mut is_recording = state.is_recording.lock().map_err(|e| e.to_string())?;
    
    if !*is_recording {
        return Err("Not recording".to_string());
    }
    
    *is_recording = false;
    drop(is_recording);
    
    let events = state.current_events.lock()
        .map_err(|e| e.to_string())?
        .clone();
    
    Ok(events)
}

#[tauri::command]
fn save_recording(
    app_handle: AppHandle,
    name: String,
    events: Vec<InputEvent>,
) -> Result<Recording, String> {
    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    
    std::fs::create_dir_all(&app_data_dir).map_err(|e| e.to_string())?;
    
    let recordings_file = app_data_dir.join("recordings.json");
    
    let mut recordings: Vec<Recording> = if recordings_file.exists() {
        let content = std::fs::read_to_string(&recordings_file).map_err(|e| e.to_string())?;
        serde_json::from_str(&content).unwrap_or_default()
    } else {
        Vec::new()
    };
    
    let recording = Recording {
        id: Utc::now().timestamp_millis().to_string(),
        name,
        events,
        created_at: Utc::now().timestamp_millis(),
    };
    
    recordings.push(recording.clone());
    
    let content = serde_json::to_string_pretty(&recordings).map_err(|e| e.to_string())?;
    std::fs::write(&recordings_file, content).map_err(|e| e.to_string())?;
    
    Ok(recording)
}

#[tauri::command]
fn load_recordings(app_handle: AppHandle) -> Result<Vec<Recording>, String> {
    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    
    let recordings_file = app_data_dir.join("recordings.json");
    
    if !recordings_file.exists() {
        return Ok(Vec::new());
    }
    
    let content = std::fs::read_to_string(&recordings_file).map_err(|e| e.to_string())?;
    let recordings: Vec<Recording> = serde_json::from_str(&content).unwrap_or_default();
    
    Ok(recordings)
}

#[tauri::command]
fn delete_recording(app_handle: AppHandle, id: String) -> Result<(), String> {
    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    
    let recordings_file = app_data_dir.join("recordings.json");
    
    if !recordings_file.exists() {
        return Err("No recordings found".to_string());
    }
    
    let content = std::fs::read_to_string(&recordings_file).map_err(|e| e.to_string())?;
    let mut recordings: Vec<Recording> = serde_json::from_str(&content).unwrap_or_default();
    
    recordings.retain(|r| r.id != id);
    
    let content = serde_json::to_string_pretty(&recordings).map_err(|e| e.to_string())?;
    std::fs::write(&recordings_file, content).map_err(|e| e.to_string())?;
    
    Ok(())
}

#[tauri::command]
fn update_recording_name(app_handle: AppHandle, id: String, name: String) -> Result<Recording, String> {
    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    
    let recordings_file = app_data_dir.join("recordings.json");
    
    if !recordings_file.exists() {
        return Err("No recordings found".to_string());
    }
    
    let content = std::fs::read_to_string(&recordings_file).map_err(|e| e.to_string())?;
    let mut recordings: Vec<Recording> = serde_json::from_str(&content).unwrap_or_default();
    
    let recording = recordings
        .iter_mut()
        .find(|r| r.id == id)
        .ok_or_else(|| "Recording not found".to_string())?;
    
    recording.name = name.clone();
    let updated_recording = recording.clone();
    
    let content = serde_json::to_string_pretty(&recordings).map_err(|e| e.to_string())?;
    std::fs::write(&recordings_file, content).map_err(|e| e.to_string())?;
    
    Ok(updated_recording)
}

#[tauri::command]
fn play_recording(
    app_handle: AppHandle,
    state: State<RecordingState>,
    events: Vec<InputEvent>,
    loop_forever: Option<bool>,
) -> Result<(), String> {
    let mut is_playing = state.is_playing.lock().map_err(|e| e.to_string())?;

    if *is_playing {
        return Err("Already playing".to_string());
    }

    if events.is_empty() {
        return Err("No events to play".to_string());
    }

    *is_playing = true;
    drop(is_playing);

    let loop_forever = loop_forever.unwrap_or(true);

    // Check if there are any playable events (non-KeyCombo)
    let has_playable_events = events.iter().any(|e| !matches!(e, InputEvent::KeyCombo { .. }));
    if !has_playable_events {
        let mut is_playing = state.is_playing.lock().map_err(|e| e.to_string())?;
        *is_playing = false;
        return Err("No playable events found".to_string());
    }

    // Reset playback position and loop count
    {
        let mut position = state.playback_position.lock().map_err(|e| e.to_string())?;
        *position = None;
    }
    {
        let mut count = state.loop_count.lock().map_err(|e| e.to_string())?;
        *count = 0;
    }

    let is_playing_clone = Arc::clone(&state.is_playing);
    let playback_position_clone = Arc::clone(&state.playback_position);
    let loop_count_clone = Arc::clone(&state.loop_count);
    let events_clone = events.clone();

    // Spawn playback in a separate thread
    thread::spawn(move || {
        // Small initial delay to ensure UI listeners are ready
        thread::sleep(Duration::from_millis(100));

        let mut is_first_iteration = true;

        loop {
            // Check if playback was stopped before starting iteration
            if let Ok(playing) = is_playing_clone.lock() {
                if !*playing {
                    break;
                }
            }

            // Emit loop restart event (not on first iteration)
            if !is_first_iteration {
                // Increment loop count
                if let Ok(mut count) = loop_count_clone.lock() {
                    *count += 1;
                }

                // Reset position to 0
                if let Ok(mut position) = playback_position_clone.lock() {
                    *position = Some(0);
                }
                let _ = app_handle.emit("playback-loop-restart", ());

                // Brief gap between loops
                thread::sleep(Duration::from_millis(50));
            }

            // Emit initial position for first event
            if is_first_iteration && !events_clone.is_empty() {
                if let Ok(mut position) = playback_position_clone.lock() {
                    *position = Some(0);
                }
                let _ = app_handle.emit("playback-position", 0);
                thread::sleep(Duration::from_millis(50));
            }

            is_first_iteration = false;
            let mut was_stopped = false;

            // Iterate through ALL events to show progress through everything
            for (index, event) in events_clone.iter().enumerate() {
                // Check if playback was stopped
                if let Ok(playing) = is_playing_clone.lock() {
                    if !*playing {
                        was_stopped = true;
                        break;
                    }
                }

                // Update playback position for ALL events (including KeyCombo)
                // Throttle UI updates for MouseMove events to avoid choppiness
                let should_update_ui = match event {
                    InputEvent::MouseMove { .. } => {
                        // Only update UI every 3rd MouseMove event or if it's been >50ms since last update
                        if index == 0 {
                            true
                        } else if index % 3 == 0 {
                            true
                        } else {
                            // Check if enough time has passed since the last UI update
                            let event_time = event.timestamp();
                            let check_index = (index.saturating_sub(3)).max(0);
                            let prev_time = events_clone[check_index].timestamp();
                            (event_time - prev_time) > 50
                        }
                    },
                    _ => true, // Always update UI for non-MouseMove events
                };

                if should_update_ui {
                    if let Ok(mut position) = playback_position_clone.lock() {
                        *position = Some(index);
                    }
                    // Emit playback position event
                    let _ = app_handle.emit("playback-position", index);
                    // Small delay to ensure UI has time to update (only when we update)
                    thread::sleep(Duration::from_millis(10));
                }

                // Calculate delay from previous event
                let delay = if index == 0 {
                    0
                } else {
                    let event_time = event.timestamp();
                    let prev_time = events_clone[index - 1].timestamp();
                    (event_time - prev_time).max(0) as u64
                };

                // Determine minimum delay based on event type
                let min_delay = match event {
                    InputEvent::MouseMove { .. } => 5, // Minimum 5ms between mouse moves for smoothness
                    _ => 1, // Minimum 1ms for other events
                };

                // Wait for the delay (but ensure minimum delay)
                if index == 0 {
                    // First event: small delay to ensure UI is ready
                    thread::sleep(Duration::from_millis(50));
                } else {
                    let actual_delay = delay.max(min_delay);
                    if actual_delay > 0 {
                        thread::sleep(Duration::from_millis(actual_delay));
                    }
                }

                // Only simulate non-KeyCombo events
                if !matches!(event, InputEvent::KeyCombo { .. }) {
                    // Simulate the event
                    let event_type = match event {
                        InputEvent::KeyPress { key, .. } => {
                            if let Some(k) = string_to_key(key) {
                                Some(EventType::KeyPress(k))
                            } else {
                                eprintln!("Unknown key: {}", key);
                                None
                            }
                        },
                        InputEvent::KeyRelease { key, .. } => {
                            if let Some(k) = string_to_key(key) {
                                Some(EventType::KeyRelease(k))
                            } else {
                                eprintln!("Unknown key: {}", key);
                                None
                            }
                        },
                        InputEvent::ButtonPress { button, x, y, .. } => {
                            if let Some(b) = string_to_button(button) {
                                // Move mouse first, then press
                                if let Err(e) = simulate(&EventType::MouseMove { x: *x, y: *y }) {
                                    eprintln!("Failed to move mouse: {:?}", e);
                                }
                                thread::sleep(Duration::from_millis(10));
                                Some(EventType::ButtonPress(b))
                            } else {
                                eprintln!("Unknown button: {}", button);
                                None
                            }
                        },
                        InputEvent::ButtonRelease { button, x, y, .. } => {
                            if let Some(b) = string_to_button(button) {
                                // Move mouse first, then release
                                if let Err(e) = simulate(&EventType::MouseMove { x: *x, y: *y }) {
                                    eprintln!("Failed to move mouse: {:?}", e);
                                }
                                thread::sleep(Duration::from_millis(10));
                                Some(EventType::ButtonRelease(b))
                            } else {
                                eprintln!("Unknown button: {}", button);
                                None
                            }
                        },
                        InputEvent::MouseMove { x, y, .. } => {
                            Some(EventType::MouseMove { x: *x, y: *y })
                        },
                        InputEvent::KeyCombo { .. } => None, // Should not reach here due to check above
                    };

                    if let Some(et) = event_type {
                        if let Err(e) = simulate(&et) {
                            eprintln!("Failed to simulate event: {:?}", e);
                        }
                        // Small delay after each event
                        thread::sleep(Duration::from_millis(10));
                    }
                }
            }

            // If stopped or not looping, exit the loop
            if was_stopped || !loop_forever {
                break;
            }
        }

        // Mark playback as complete
        if let Ok(mut playing) = is_playing_clone.lock() {
            *playing = false;
        }
        if let Ok(mut position) = playback_position_clone.lock() {
            *position = None;
        }
        if let Ok(mut count) = loop_count_clone.lock() {
            *count = 0;
        }
        // Emit completion event
        let _ = app_handle.emit("playback-complete", ());
    });

    Ok(())
}

#[tauri::command]
fn stop_playback(state: State<RecordingState>) -> Result<(), String> {
    let mut is_playing = state.is_playing.lock().map_err(|e| e.to_string())?;
    *is_playing = false;
    drop(is_playing);
    let mut position = state.playback_position.lock().map_err(|e| e.to_string())?;
    *position = None;
    drop(position);
    let mut count = state.loop_count.lock().map_err(|e| e.to_string())?;
    *count = 0;
    Ok(())
}

#[tauri::command]
fn is_playing(state: State<RecordingState>) -> Result<bool, String> {
    let is_playing = state.is_playing.lock().map_err(|e| e.to_string())?;
    Ok(*is_playing)
}

// Helper trait to get timestamp from InputEvent
trait InputEventTimestamp {
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

#[tauri::command]
fn set_window_size(window: WebviewWindow, width: u32, height: u32) -> Result<(), String> {
    use tauri::{LogicalSize, Size};
    
    // Set the window size with dynamic width and height
    let new_size = LogicalSize::new(width as f64, height as f64);
    window
        .set_size(Size::Logical(new_size))
        .map_err(|e| format!("Failed to resize window: {}", e))?;
    
    Ok(())
}

#[tauri::command]
fn toggle_visibility(app_handle: AppHandle) -> Result<bool, String> {
    if let Some(window) = app_handle.get_webview_window("main") {
        let is_visible = window.is_visible().map_err(|e| e.to_string())?;
        
        if is_visible {
            #[cfg(target_os = "macos")]
            {
                if let Ok(panel) = app_handle.get_webview_panel("main") {
                    panel.hide();
                }
            }
            window.hide().map_err(|e| e.to_string())?;
            Ok(false)
        } else {
            window.show().map_err(|e| e.to_string())?;
            // Don't call set_focus() - this allows clicks without requiring double-click
            // The non-activating panel style allows receiving events without activation
            
            #[cfg(target_os = "macos")]
            {
                if let Ok(panel) = app_handle.get_webview_panel("main") {
                    panel.show();
                }
            }
            Ok(true)
        }
    } else {
        Err("Window not found".to_string())
    }
}

#[cfg(target_os = "macos")]
fn init_macos_panel(app_handle: &AppHandle) {
    use tauri_nspanel::{CollectionBehavior, PanelLevel, StyleMask};
    
    let window: WebviewWindow = app_handle.get_webview_window("main").unwrap();
    let panel = window.to_panel::<MacroPanel>().unwrap();
    
    // Set the window to float level
    panel.set_level(PanelLevel::Floating.value());
    
    // Ensures the panel cannot activate the app
    panel.set_style_mask(StyleMask::empty().nonactivating_panel().into());
    
    // Allows the panel to display on the same space as fullscreen window and join all spaces
    panel.set_collection_behavior(
        CollectionBehavior::new()
            .full_screen_auxiliary()
            .can_join_all_spaces()
            .into(),
    );
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let state = RecordingState::default();
    let is_recording = Arc::clone(&state.is_recording);
    let events = Arc::clone(&state.current_events);
    let last_pos = Arc::clone(&state.last_mouse_position);
    let pressed_modifiers = Arc::clone(&state.pressed_modifiers);
    let pressed_buttons = Arc::clone(&state.pressed_buttons);
    
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init());
    
    // Initialize nspanel plugin on macOS (MUST be before setup)
    #[cfg(target_os = "macos")]
    {
        builder = builder.plugin(tauri_nspanel::init());
    }
    
    builder
        .plugin(tauri_plugin_global_shortcut::Builder::new()
            .with_handler(|app, shortcut, event| {
                use tauri_plugin_global_shortcut::ShortcutState;

                // Only trigger on key press, not release
                if event.state() != ShortcutState::Pressed {
                    return;
                }

                let shortcut_str = shortcut.to_string().to_lowercase();

                match shortcut_str.as_str() {
                    "cmd+m" | "ctrl+m" | "super+m" => {
                        let _ = toggle_visibility(app.clone());
                    }
                    "cmd+r" | "ctrl+r" | "super+r" => {
                        // Emit toggle-playback event to frontend
                        let _ = app.emit("toggle-playback", ());
                    }
                    _ => {}
                }
            })
            .build()
        )
        .setup(move |app| {
            // Register Cmd+M (macOS) or Ctrl+M (Windows/Linux) to toggle visibility
            #[cfg(target_os = "macos")]
            let shortcut_str = "cmd+m";
            #[cfg(not(target_os = "macos"))]
            let shortcut_str = "ctrl+m";

            if let Err(e) = app.global_shortcut().register(shortcut_str) {
                eprintln!("Failed to register global shortcut: {}", e);
            }

            // Register Cmd+R (macOS) or Ctrl+R (Windows/Linux) to toggle playback
            #[cfg(target_os = "macos")]
            let play_shortcut_str = "cmd+r";
            #[cfg(not(target_os = "macos"))]
            let play_shortcut_str = "ctrl+r";

            if let Err(e) = app.global_shortcut().register(play_shortcut_str) {
                eprintln!("Failed to register playback shortcut: {}", e);
            }
            
            // Initialize macOS NSPanel configuration
            #[cfg(target_os = "macos")]
            init_macos_panel(app.app_handle());
            
            let app_handle = app.handle().clone();
            
            // Create a channel for sending events from listener thread
            let (tx, rx) = channel::<InputEvent>();
            
            // Spawn thread to handle received events
            std::thread::spawn(move || {
                while let Ok(event) = rx.recv() {
                    // Add to state
                    if let Ok(mut evts) = events.lock() {
                        evts.push(event.clone());
                    }
                    
                    // Emit event to frontend
                    let _ = app_handle.emit("input-event", &event);
                }
            });
            
            // Spawn the input listener thread
            tauri::async_runtime::spawn(async move {
                #[cfg(target_os = "macos")]
                rdev::set_is_main_thread(false);
                
                let callback = move |event: Event| {
                    let recording = is_recording.lock().ok().map(|r| *r).unwrap_or(false);
                    
                    if !recording {
                        return;
                    }
                    
                    let timestamp = Utc::now().timestamp_millis();
                    
                    match event.event_type {
                        EventType::KeyPress(key) => {
                            // Track modifier state
                            if is_modifier_key(key) {
                                if let Ok(mut modifiers) = pressed_modifiers.lock() {
                                    modifiers.insert(key);
                                }
                            }
                            
                            // Always emit the individual KeyPress event
                            let key_str = key_to_string(key);
                            let key_press_event = InputEvent::KeyPress {
                                key: key_str.clone(),
                                timestamp,
                            };
                            let _ = tx.send(key_press_event);
                            
                            // If this is a non-modifier key and modifiers are active, try to recognize the combo
                            if !is_modifier_key(key) {
                                if let Ok(modifiers) = pressed_modifiers.lock() {
                                    if let Some(recognized_char) = get_character_with_modifiers(key, &modifiers) {
                                        let modifier_names: Vec<String> = modifiers
                                            .iter()
                                            .filter(|k| is_modifier_key(**k))
                                            .map(|k| key_to_string(*k))
                                            .collect();
                                        
                                        let combo_event = InputEvent::KeyCombo {
                                            char: recognized_char,
                                            key: key_str,
                                            modifiers: modifier_names,
                                            timestamp,
                                        };
                                        let _ = tx.send(combo_event);
                                    }
                                }
                            }
                        },
                        EventType::KeyRelease(key) => {
                            // Remove from modifier state
                            if is_modifier_key(key) {
                                if let Ok(mut modifiers) = pressed_modifiers.lock() {
                                    modifiers.remove(&key);
                                }
                            }
                            
                            // Emit the KeyRelease event
                            let key_release_event = InputEvent::KeyRelease {
                                key: key_to_string(key),
                                timestamp,
                            };
                            let _ = tx.send(key_release_event);
                        },
                        EventType::ButtonPress(button) => {
                            // Track button state
                            if let Ok(mut buttons) = pressed_buttons.lock() {
                                buttons.insert(button);
                            }
                            
                            let pos = last_pos.lock().ok().and_then(|p| *p).unwrap_or((0.0, 0.0));
                            let button_press_event = InputEvent::ButtonPress {
                                button: button_to_string(button),
                                x: pos.0,
                                y: pos.1,
                                timestamp,
                            };
                            let _ = tx.send(button_press_event);
                        },
                        EventType::ButtonRelease(button) => {
                            // Remove from button state
                            if let Ok(mut buttons) = pressed_buttons.lock() {
                                buttons.remove(&button);
                            }
                            
                            let pos = last_pos.lock().ok().and_then(|p| *p).unwrap_or((0.0, 0.0));
                            let button_release_event = InputEvent::ButtonRelease {
                                button: button_to_string(button),
                                x: pos.0,
                                y: pos.1,
                                timestamp,
                            };
                            let _ = tx.send(button_release_event);
                        },
                        EventType::MouseMove { x, y } => {
                            // Update last known mouse position
                            if let Ok(mut pos) = last_pos.lock() {
                                *pos = Some((x, y));
                            }
                            
                            // Record mouse move if any buttons are pressed (dragging)
                            if let Ok(buttons) = pressed_buttons.lock() {
                                if !buttons.is_empty() {
                                    let mouse_move_event = InputEvent::MouseMove {
                                        x,
                                        y,
                                        timestamp,
                                    };
                                    let _ = tx.send(mouse_move_event);
                                }
                            }
                        },
                        _ => {}
                    }
                };
                
                if let Err(e) = listen(callback) {
                    eprintln!("Error in input listener: {:?}", e);
                }
            });
            
            Ok(())
        })
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            start_recording,
            stop_recording,
            save_recording,
            load_recordings,
            delete_recording,
            update_recording_name,
            play_recording,
            stop_playback,
            is_playing,
            set_window_size,
            toggle_visibility,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
