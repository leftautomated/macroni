mod capture;
mod crash_log;
mod encoder;
mod event_capture;
mod key_mapping;
mod permissions;
mod playback;
mod recording_session;
mod recordings_store;
mod settings;
mod types;

use types::*;

use chrono::Utc;
use rdev::{listen, Event};
use std::sync::mpsc::channel;
use std::sync::Arc;
use std::thread;
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
fn start_recording(app: AppHandle, state: State<RecordingState>) -> Result<String, String> {
    if state.session.is_active() {
        return Err("Already recording".to_string());
    }

    // Generate recording id up front so the video filename can use it.
    let id = chrono::Utc::now().timestamp_millis().to_string();

    // Build capture config from settings.
    let settings = crate::settings::load(&app);
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let videos_dir = app_data_dir.join("videos");
    std::fs::create_dir_all(&videos_dir).map_err(|e| e.to_string())?;
    let output_path = videos_dir.join(format!("{}.mp4", id));

    // Start capture (may fail on permission denied — surface the error).
    let capture = match crate::capture::ScreenCaptureSession::start(crate::capture::CaptureConfig {
        output_path,
        settings: settings.capture,
    }) {
        Ok(session) => Some(session),
        Err(e) if e == "permission-denied" => {
            let _ = app.emit("permission-needed", "screen-recording");
            return Err(e);
        }
        Err(e) => {
            // Capture failed for another reason; we still allow event-only recording.
            let _ = app.emit("capture-failed", e.clone());
            eprintln!("capture failed to start: {e}");
            None
        }
    };

    state
        .session
        .start(id.clone(), capture)
        .map_err(|e| e.to_string())?;
    Ok(id)
}

#[derive(serde::Serialize)]
struct StopResult {
    id: String,
    events: Vec<InputEvent>,
    video: Option<VideoMetadata>,
}

#[tauri::command]
fn stop_recording(state: State<RecordingState>) -> Result<StopResult, String> {
    let stopped = state.session.stop().map_err(|e| e.to_string())?;
    let video = stopped.capture.and_then(|s| match s.stop() {
        Ok(meta) => Some(meta),
        Err(e) => {
            eprintln!("capture finalize failed: {e}");
            None
        }
    });
    Ok(StopResult {
        id: stopped.id,
        events: stopped.events,
        video,
    })
}

#[tauri::command]
fn save_recording(
    app_handle: AppHandle,
    id: String,
    name: String,
    events: Vec<InputEvent>,
    video: Option<VideoMetadata>,
) -> Result<Recording, String> {
    let recording = Recording {
        id,
        name,
        events,
        created_at: chrono::Utc::now().timestamp_millis(),
        playback_speed: 1.0,
        video,
    };
    recordings_store::RecordingsStore::open(&app_handle)
        .and_then(|s| s.add(recording))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn load_recordings(app_handle: AppHandle) -> Result<Vec<Recording>, String> {
    recordings_store::RecordingsStore::open(&app_handle)
        .and_then(|s| s.load_all())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_recording(app_handle: AppHandle, id: String) -> Result<(), String> {
    recordings_store::RecordingsStore::open(&app_handle)
        .and_then(|s| s.delete(&id))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn update_recording_name(
    app_handle: AppHandle,
    id: String,
    name: String,
) -> Result<Recording, String> {
    recordings_store::RecordingsStore::open(&app_handle)
        .and_then(|s| s.update_name(&id, &name))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn update_recording_speed(
    app_handle: AppHandle,
    id: String,
    speed: f64,
) -> Result<Recording, String> {
    recordings_store::RecordingsStore::open(&app_handle)
        .and_then(|s| s.update_speed(&id, speed))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn play_recording(
    app_handle: AppHandle,
    state: State<RecordingState>,
    events: Vec<InputEvent>,
    loop_forever: Option<bool>,
    speed: Option<f64>,
) -> Result<(), String> {
    let loop_forever = loop_forever.unwrap_or(true);
    let speed = speed.unwrap_or(1.0);
    let plan = playback::PlaybackPlan::compile(&events, speed).map_err(|e| e.to_string())?;
    state.engine.start(
        plan,
        loop_forever,
        playback::RdevSimulator,
        playback::TauriEmitter::new(app_handle),
    )
}

#[tauri::command]
fn stop_playback(state: State<RecordingState>) -> Result<(), String> {
    state.engine.stop();
    Ok(())
}

#[tauri::command]
fn is_playing(state: State<RecordingState>) -> Result<bool, String> {
    Ok(state.engine.is_playing())
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
fn open_playback_window(app: AppHandle, recording_id: String) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("playback") {
        window
            .eval(format!(
                "window.location.href = 'playback.html?id={}'",
                recording_id
            ))
            .map_err(|e| e.to_string())?;
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }
    Err("playback window not configured".to_string())
}

#[tauri::command]
fn get_app_data_dir(app: AppHandle) -> Result<String, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().into_owned())
}

#[tauri::command]
fn toggle_visibility(app_handle: AppHandle) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        use tauri_nspanel::PanelLevel;

        // Use NSPanel's is_visible() as source of truth — Tauri's window.is_visible()
        // can get out of sync when macOS hides the panel (sleep, space switch, etc.)
        let panel = app_handle
            .get_webview_panel("main")
            .map_err(|e| format!("{:?}", e))?;
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
    // Install panic → crash.log hook FIRST so any panic during Tauri init is
    // captured. Path: ~/Library/Application Support/Macroni/crash.log (macOS),
    // %APPDATA%\Macroni\crash.log (Windows).
    crash_log::install_panic_hook();

    let state = RecordingState::default();
    let listener_session = Arc::clone(&state.session);
    let collector_session = Arc::clone(&state.session);
    let shortcut_engine = Arc::clone(&state.engine);

    let mut builder = tauri::Builder::default().plugin(tauri_plugin_opener::init());

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
                            let engine = Arc::clone(&shortcut_engine);
                            move |app, shortcut, event| {
                                use tauri_plugin_global_shortcut::{
                                    Code, Modifiers, ShortcutState,
                                };

                                if event.state() != ShortcutState::Pressed {
                                    return;
                                }

                                // Cmd+M / Ctrl+M — toggle visibility
                                if shortcut.matches(Modifiers::SUPER, Code::KeyM) {
                                    let _ = toggle_visibility(app.clone());
                                }
                                // Cmd+R / Ctrl+R — toggle playback.
                                // Stop directly in Rust to avoid frontend round-trip
                                // latency and simulated keystrokes interfering with
                                // the shortcut.
                                else if shortcut.matches(Modifiers::SUPER, Code::KeyR) {
                                    if engine.is_playing() {
                                        engine.stop();
                                        let _ = app.emit("playback-stopped", ());
                                    } else {
                                        let _ = app.emit("toggle-playback", ());
                                    }
                                }
                                // Cmd+Shift+R / Ctrl+Shift+R — toggle recording
                                else if shortcut
                                    .matches(Modifiers::SUPER | Modifiers::SHIFT, Code::KeyR)
                                {
                                    let _ = app.emit("toggle-recording", ());
                                }
                            }
                        })
                        .build(),
                )?;
            }

            crash_log::log_line("setup: start");

            // Initialize macOS NSPanel configuration
            #[cfg(target_os = "macos")]
            init_macos_panel(app.app_handle());

            // Clean up orphaned video files from prior crashes.
            if let Ok(store) = recordings_store::RecordingsStore::open(app.app_handle()) {
                store.sweep_orphan_videos();
            }

            crash_log::log_line("setup: complete");

            let app_handle = app.handle().clone();

            // Create a channel for sending events from listener thread
            let (tx, rx) = channel::<InputEvent>();

            // Spawn thread to handle received events
            std::thread::spawn(move || {
                while let Ok(event) = rx.recv() {
                    collector_session.push_event(event.clone());
                    let _ = app_handle.emit("input-event", &event);
                }
            });

            // Spawn the input listener on a real OS thread.
            // On Windows, rdev::listen requires a thread with a message pump;
            // tokio async tasks don't provide one, causing an immediate crash.
            thread::spawn(move || {
                #[cfg(target_os = "macos")]
                rdev::set_is_main_thread(false);

                let mut capture = event_capture::EventCapture::new();
                let callback = move |event: Event| {
                    if !listener_session.is_active() {
                        return;
                    }
                    let timestamp = Utc::now().timestamp_millis();
                    for ev in capture.on_rdev_event(event.event_type, timestamp) {
                        let _ = tx.send(ev);
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
            permissions::check_screen_recording_permission,
            permissions::request_screen_recording,
            open_playback_window,
            get_app_data_dir,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
