mod types;
mod key_mapping;
mod settings;
mod capture;

use types::*;
use key_mapping::*;

use std::sync::Arc;
use std::sync::mpsc::channel;
use std::thread;
use std::time::Duration;
use rdev::{listen, simulate, Event, EventType};
use chrono::Utc;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

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
        playback_speed: 1.0,
        video: None,
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
fn update_recording_speed(app_handle: AppHandle, id: String, speed: f64) -> Result<Recording, String> {
    if !speed.is_finite() || speed <= 0.0 || speed > 1000.0 {
        return Err("Speed must be between 0.01 and 1000".to_string());
    }

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

    recording.playback_speed = speed;
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
    speed: Option<f64>,
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
    let speed = speed.unwrap_or(1.0);
    let speed = if speed.is_nan() || speed <= 0.0 { 1.0 } else { speed.max(0.01) };

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

                // At high speeds, skip UI update sleeps to avoid inflating delays
                let mut overhead_ms: u64 = 0;
                if should_update_ui {
                    if let Ok(mut position) = playback_position_clone.lock() {
                        *position = Some(index);
                    }
                    let _ = app_handle.emit("playback-position", index);
                    if speed <= 2.0 {
                        thread::sleep(Duration::from_millis(10));
                        overhead_ms += 10;
                    }
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

                // Wait for the delay (scaled by speed), subtracting overhead already incurred
                if index == 0 {
                    thread::sleep(Duration::from_millis(50));
                } else {
                    let scaled_delay = (delay as f64 / speed) as u64;
                    let actual_delay = scaled_delay.saturating_sub(overhead_ms).max(min_delay);
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
                        // Small delay after each event (reduced at high speeds)
                        if speed <= 2.0 {
                            thread::sleep(Duration::from_millis(10));
                        } else {
                            thread::sleep(Duration::from_millis(1));
                        }
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
    #[cfg(target_os = "macos")]
    {
        use tauri_nspanel::PanelLevel;

        // Use NSPanel's is_visible() as source of truth — Tauri's window.is_visible()
        // can get out of sync when macOS hides the panel (sleep, space switch, etc.)
        let panel = app_handle.get_webview_panel("main").map_err(|e| format!("{:?}", e))?;
        if panel.is_visible() {
            panel.hide();
            Ok(false)
        } else {
            // Re-assert floating level — macOS can reset it after display sleep or
            // Mission Control transitions
            panel.set_level(PanelLevel::Floating.value());
            panel.show();
            Ok(true)
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        if let Some(window) = app_handle.get_webview_window("main") {
            let is_visible = window.is_visible().map_err(|e| e.to_string())?;
            if is_visible {
                window.hide().map_err(|e| e.to_string())?;
                Ok(false)
            } else {
                window.show().map_err(|e| e.to_string())?;
                Ok(true)
            }
        } else {
            Err("Window not found".to_string())
        }
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

    // Prevent macOS from hiding the panel when the app deactivates.
    // Since this is a non-activating panel (can_become_key_window: false),
    // macOS considers it always "deactivated" and will hide it by default.
    panel.set_hides_on_deactivate(false);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let state = RecordingState::default();
    let is_recording = Arc::clone(&state.is_recording);
    let events = Arc::clone(&state.current_events);
    let last_pos = Arc::clone(&state.last_mouse_position);
    let pressed_modifiers = Arc::clone(&state.pressed_modifiers);
    let pressed_buttons = Arc::clone(&state.pressed_buttons);
    let shortcut_is_playing = Arc::clone(&state.is_playing);

    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init());
    
    // Initialize nspanel plugin on macOS (MUST be before setup)
    #[cfg(target_os = "macos")]
    {
        builder = builder.plugin(tauri_nspanel::init());
    }
    
    builder
        .setup(move |app| {
            // Register global shortcuts inside setup using the correct Tauri v2 pattern
            #[cfg(desktop)]
            {
                app.handle().plugin(
                    tauri_plugin_global_shortcut::Builder::new()
                        .with_shortcuts(["super+m", "super+r", "super+shift+r"])?
                        .with_handler({
                            let is_playing = Arc::clone(&shortcut_is_playing);
                            move |app, shortcut, event| {
                                use tauri_plugin_global_shortcut::{Code, Modifiers, ShortcutState};

                                if event.state() != ShortcutState::Pressed {
                                    return;
                                }

                                // Cmd+M / Ctrl+M — toggle visibility
                                if shortcut.matches(Modifiers::SUPER, Code::KeyM) {
                                    let _ = toggle_visibility(app.clone());
                                }
                                // Cmd+R / Ctrl+R — toggle playback
                                // Stop directly in Rust to avoid frontend round-trip latency
                                // and simulated keystrokes interfering with the shortcut
                                else if shortcut.matches(Modifiers::SUPER, Code::KeyR) {
                                    let currently_playing = is_playing.lock()
                                        .map(|p| *p)
                                        .unwrap_or(false);
                                    if currently_playing {
                                        if let Ok(mut p) = is_playing.lock() {
                                            *p = false;
                                        }
                                        let _ = app.emit("playback-stopped", ());
                                    } else {
                                        let _ = app.emit("toggle-playback", ());
                                    }
                                }
                                // Cmd+Shift+R / Ctrl+Shift+R — toggle recording
                                else if shortcut.matches(Modifiers::SUPER | Modifiers::SHIFT, Code::KeyR) {
                                    let _ = app.emit("toggle-recording", ());
                                }
                            }
                        })
                        .build()
                )?;
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
            
            // Spawn the input listener on a real OS thread.
            // On Windows, rdev::listen requires a thread with a message pump;
            // tokio async tasks don't provide one, causing an immediate crash.
            thread::spawn(move || {
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
            update_recording_speed,
            play_recording,
            stop_playback,
            is_playing,
            set_window_size,
            toggle_visibility,
            settings::load_settings,
            settings::save_settings,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
