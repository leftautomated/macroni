mod capture;
mod crash_log;
#[cfg(not(target_os = "windows"))]
mod encoder;
mod event_capture;
mod key_mapping;
mod macros;
mod observability;
mod perception;
mod permissions;
mod playback;
// No App Nap / timer-coalescing guard held for the duration of a replay or
// macro run (playback throttle fix). Real assertion on macOS, no-op elsewhere.
mod power;
// Native studio preview surface (Phase 1, Task 11). macOS-only.
#[cfg(target_os = "macos")]
mod preview_surface;
mod project_store;
mod recording_session;
mod recordings_store;
mod settings;
mod space_switch;
// Native macOS Space-switch watcher (gesture-capture Task 4). macOS-only.
#[cfg(target_os = "macos")]
mod space_watch;
mod studio_export;
mod types;

use types::*;

use chrono::Utc;
use rdev::{listen, Event};
use serde_json::json;
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
fn start_recording(
    app: AppHandle,
    state: State<RecordingState>,
    trace_id: Option<String>,
) -> Result<String, String> {
    observability::trace_command("start_recording", trace_id, None, || {
        // Best-effort early-return so we don't acquire the screen-recording
        // permission and spawn a scap thread just to drop them when session.start
        // fails below. The authoritative guard is session.start() — it runs under
        // the inner mutex and atomically claims the slot. A small TOCTOU window
        // between this read and session.start can produce a spurious "Already
        // recording" error during a concurrent stop; the user retries and it
        // succeeds. We accept that vs. leaking a capture thread.
        if state.session.is_active() {
            return Err("Already recording".to_string());
        }

        // Generate recording id up front so the video filename can use it.
        let id = chrono::Utc::now().timestamp_millis().to_string();

        // Build capture config from settings.
        let settings = crate::settings::load(&app);

        // Perception tee: opt-in continuous OCR (macOS-only extractor for now).
        // Build the channel BEFORE CaptureConfig so `tee` can move into capture
        // and `perception_rx` stays here to feed the worker once capture starts.
        let mut tee = None;
        let mut perception_rx = None;
        if settings.capture.video
            && settings.perception.continuous_ocr
            && crate::perception::extractor::continuous_extractor().is_some()
        {
            let (tx, rx) = std::sync::mpsc::sync_channel::<crate::capture::Frame>(1);
            tee = Some(tx);
            perception_rx = Some(rx);
        }

        // Start capture (may fail on permission denied — surface the error).
        let capture = if settings.capture.video {
            let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
            let videos_dir = app_data_dir.join("videos");
            std::fs::create_dir_all(&videos_dir).map_err(|e| e.to_string())?;
            let output_path = videos_dir.join(format!("{}.mp4", id));
            match crate::capture::ScreenCaptureSession::start(crate::capture::CaptureConfig {
                output_path,
                settings: settings.capture.clone(),
                tee,
            }) {
                Ok(session) => Some(session),
                Err(e) if e == "permission-denied" => {
                    let _ = app.emit("permission-needed", "screen-recording");
                    return Err(e);
                }
                Err(e) => {
                    // Capture failed for another reason; we still allow event-only recording.
                    let _ = app.emit("capture-failed", e.clone());
                    observability::log_warn(
                        "capture",
                        "start_failed_event_only",
                        &e,
                        Some(json!({ "recordingId": id })),
                    );
                    None
                }
            }
        } else {
            observability::log_info(
                "capture",
                "disabled_event_only",
                Some(json!({ "recordingId": id })),
            );
            None
        };

        // Spawn the perception worker only when capture actually started and a
        // tee channel was created; timestamps are video-relative via start_ms().
        let perception = match (&capture, perception_rx) {
            (Some(cap), Some(rx)) => {
                crate::perception::extractor::continuous_extractor().map(|ex| {
                    crate::perception::worker::PerceptionWorker::spawn(rx, cap.start_ms(), ex)
                })
            }
            _ => None,
        };

        state
            .session
            .start(id.clone(), capture, perception)
            .map_err(|e| e.to_string())?;
        observability::log_info(
            "recording",
            "started",
            Some(json!({
                "recordingId": id,
                "video": settings.capture.video,
                "fps": settings.capture.fps,
                "quality": settings.capture.quality,
                "audio": settings.capture.audio,
            })),
        );
        Ok(id)
    })
}

#[derive(serde::Serialize)]
struct StopResult {
    id: String,
    events: Vec<InputEvent>,
    video: Option<VideoMetadata>,
}

#[tauri::command]
fn stop_recording(
    app: AppHandle,
    state: State<RecordingState>,
    trace_id: Option<String>,
) -> Result<StopResult, String> {
    observability::trace_command("stop_recording", trace_id, None, || {
        finish_recording(&app, &state)
    })
}

/// Stop the active session, finalize capture, and flush observations. Shared
/// by the `stop_recording` command and the Rust-side global-shortcut stop —
/// a recording must always be stoppable even when the webview is unresponsive.
fn finish_recording(app: &AppHandle, state: &RecordingState) -> Result<StopResult, String> {
    let stopped = state.session.stop().map_err(|e| e.to_string())?;
    let video = stopped.capture.and_then(|s| match s.stop() {
        Ok(meta) => Some(meta),
        Err(e) => {
            // The capture session started (permission appeared granted) but
            // finalize produced no usable video — e.g. zero frames reached the
            // encoder. This used to be swallowed (eprintln only), so the user
            // got a recording with no video and NO feedback. Surface it to the
            // UI via the same `capture-failed` event the start path uses.
            observability::log_error(
                "capture",
                "finalize_failed",
                &e,
                Some(json!({ "recordingId": stopped.id })),
            );
            let _ = app.emit("capture-failed", e.clone());
            None
        }
    });

    // Flush observations after capture stop. finish() bounds the wait even if
    // the detached acquisition thread hasn't dropped the tee sender yet — see
    // the shutdown contract in perception/worker.rs.
    if let Some(worker) = stopped.perception {
        let observations = worker.finish();
        if !observations.is_empty() {
            if let Ok(store) = recordings_store::RecordingsStore::open(app) {
                if let Err(e) = store.write_observations(&stopped.id, &observations) {
                    observability::log_warn(
                        "perception",
                        "observations_flush_failed",
                        &e.to_string(),
                        None,
                    );
                }
            }
        }
    }

    observability::log_info(
        "recording",
        "stopped",
        Some(json!({
            "recordingId": stopped.id,
            "eventCount": stopped.events.len(),
            "hasVideo": video.is_some(),
        })),
    );
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
    trace_id: Option<String>,
) -> Result<Recording, String> {
    let fields = json!({
        "recordingId": id,
        "eventCount": events.len(),
        "hasVideo": video.is_some(),
    });
    observability::trace_command("save_recording", trace_id, Some(fields), || {
        let recording = Recording {
            id,
            name,
            events,
            created_at: chrono::Utc::now().timestamp_millis(),
            playback_speed: 1.0,
            scroll_unit: types::ScrollUnit::Pixels,
            video,
            targets: Vec::new(),
        };
        recordings_store::RecordingsStore::open(&app_handle)
            .and_then(|s| s.add(recording))
            .map_err(|e| e.to_string())
    })
}

#[tauri::command]
fn load_recordings(
    app_handle: AppHandle,
    trace_id: Option<String>,
) -> Result<Vec<Recording>, String> {
    observability::trace_command("load_recordings", trace_id, None, || {
        let recordings = recordings_store::RecordingsStore::open(&app_handle)
            .and_then(|s| s.load_all())
            .map_err(|e| e.to_string())?;
        observability::log_info(
            "recordings",
            "loaded",
            Some(json!({
                "count": recordings.len(),
                "videoCount": recordings.iter().filter(|r| r.video.is_some()).count(),
            })),
        );
        Ok(recordings)
    })
}

#[tauri::command]
fn delete_recording(
    app_handle: AppHandle,
    id: String,
    trace_id: Option<String>,
) -> Result<(), String> {
    let fields = json!({ "recordingId": id });
    observability::trace_command("delete_recording", trace_id, Some(fields), || {
        recordings_store::RecordingsStore::open(&app_handle)
            .and_then(|s| s.delete(&id))
            .map_err(|e| e.to_string())
    })
}

#[tauri::command]
fn update_recording_name(
    app_handle: AppHandle,
    id: String,
    name: String,
    trace_id: Option<String>,
) -> Result<Recording, String> {
    let fields = json!({ "recordingId": id, "nameLength": name.len() });
    observability::trace_command("update_recording_name", trace_id, Some(fields), || {
        recordings_store::RecordingsStore::open(&app_handle)
            .and_then(|s| s.update_name(&id, &name))
            .map_err(|e| e.to_string())
    })
}

#[tauri::command]
fn update_recording_speed(
    app_handle: AppHandle,
    id: String,
    speed: f64,
    trace_id: Option<String>,
) -> Result<Recording, String> {
    let fields = json!({ "recordingId": id, "speed": speed });
    observability::trace_command("update_recording_speed", trace_id, Some(fields), || {
        recordings_store::RecordingsStore::open(&app_handle)
            .and_then(|s| s.update_speed(&id, speed))
            .map_err(|e| e.to_string())
    })
}

#[tauri::command]
fn play_recording(
    app_handle: AppHandle,
    state: State<RecordingState>,
    events: Vec<InputEvent>,
    loop_forever: Option<bool>,
    speed: Option<f64>,
    trace_id: Option<String>,
) -> Result<(), String> {
    let fields = json!({
        "eventCount": events.len(),
        "loopForever": loop_forever.unwrap_or(true),
        "speed": speed.unwrap_or(1.0),
    });
    observability::trace_command("play_recording", trace_id, Some(fields), || {
        let loop_forever = loop_forever.unwrap_or(true);
        let speed = speed.unwrap_or(1.0);
        let plan = playback::PlaybackPlan::compile(&events, speed).map_err(|e| e.to_string())?;
        state.engine.start(
            plan,
            loop_forever,
            playback::RdevSimulator,
            playback::TauriEmitter::new(app_handle),
        )
    })
}

#[tauri::command]
fn stop_playback(state: State<RecordingState>, trace_id: Option<String>) -> Result<(), String> {
    observability::trace_command("stop_playback", trace_id, None, || {
        state.engine.stop();
        Ok(())
    })
}

#[tauri::command]
fn is_playing(state: State<RecordingState>, trace_id: Option<String>) -> Result<bool, String> {
    observability::trace_command("is_playing", trace_id, None, || {
        Ok(state.engine.is_playing())
    })
}

#[tauri::command]
fn set_window_size(
    window: WebviewWindow,
    width: u32,
    height: u32,
    trace_id: Option<String>,
) -> Result<(), String> {
    observability::trace_command(
        "set_window_size",
        trace_id,
        Some(json!({ "width": width, "height": height })),
        || {
            use tauri::{LogicalSize, Size};

            // Set the window size with dynamic width and height
            let new_size = LogicalSize::new(width as f64, height as f64);
            window
                .set_size(Size::Logical(new_size))
                .map_err(|e| format!("Failed to resize window: {}", e))?;

            Ok(())
        },
    )
}

#[tauri::command]
fn focus_studio_window(app: AppHandle, trace_id: Option<String>) -> Result<(), String> {
    observability::trace_command("focus_studio_window", trace_id, None, || {
        use tauri::{WebviewUrl, WebviewWindowBuilder};

        // The studio is defined in tauri.conf and created at startup — just show and
        // focus it. If the user closed the window (Tauri destroys on close), rebuild
        // it from the same URL so the button always works.
        if let Some(window) = app.get_webview_window("studio") {
            window.show().map_err(|e| e.to_string())?;
            window.set_focus().map_err(|e| e.to_string())?;
            return Ok(());
        }
        WebviewWindowBuilder::new(&app, "studio", WebviewUrl::App("studio.html".into()))
            .title("Studio")
            .inner_size(1200.0, 800.0)
            .min_inner_size(600.0, 400.0)
            .resizable(true)
            // Fully custom chrome — the window draws its own title bar + traffic
            // lights (see StudioTitleBar). Transparent for rounded corners.
            .decorations(false)
            .transparent(true)
            .build()
            .map_err(|e| e.to_string())?;
        Ok(())
    })
}

#[tauri::command]
fn request_replay(
    app: AppHandle,
    id: String,
    loop_forever: Option<bool>,
    trace_id: Option<String>,
) -> Result<(), String> {
    let loop_forever = loop_forever.unwrap_or(true);
    let fields = json!({ "recordingId": id, "loopForever": loop_forever });
    observability::trace_command("request_replay", trace_id, Some(fields), || {
        // Replay runs from the main control panel: it's small and non-activating, so
        // it won't steal focus from the user's target app. Bring it forward, then
        // tell the frontend which recording to load — the user focuses their target
        // and presses Play when ready (we deliberately don't auto-start).
        #[cfg(target_os = "macos")]
        {
            use tauri_nspanel::PanelLevel;
            if let Ok(panel) = app.get_webview_panel("main") {
                panel.set_level(PanelLevel::Floating.value());
                panel.show();
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            if let Some(window) = app.get_webview_window("main") {
                window.show().map_err(|e| e.to_string())?;
            }
        }
        app.emit(
            "replay-recording",
            ReplayRecordingRequest { id, loop_forever },
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ReplayRecordingRequest {
    id: String,
    loop_forever: bool,
}

#[tauri::command]
fn get_app_data_dir(app: AppHandle, trace_id: Option<String>) -> Result<String, String> {
    observability::trace_command("get_app_data_dir", trace_id, None, || {
        let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
        Ok(dir.to_string_lossy().into_owned())
    })
}

#[tauri::command]
fn toggle_visibility(app_handle: AppHandle, trace_id: Option<String>) -> Result<bool, String> {
    observability::trace_command("toggle_visibility", trace_id, None, || {
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
    })
}

#[tauri::command]
fn get_diagnostics_snapshot(
    app: AppHandle,
    state: State<RecordingState>,
    trace_id: Option<String>,
) -> Result<observability::DiagnosticsSnapshot, String> {
    observability::trace_command("get_diagnostics_snapshot", trace_id, None, || {
        Ok(observability::diagnostics_snapshot(
            &app,
            state.session.is_active(),
            state.engine.is_playing(),
        ))
    })
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
    // Space-switch watcher shares the session so it only emits while recording.
    #[cfg(target_os = "macos")]
    let watcher_session = Arc::clone(&state.session);
    let shortcut_engine = Arc::clone(&state.engine);

    let log_level = if cfg!(debug_assertions) {
        log::LevelFilter::Debug
    } else {
        log::LevelFilter::Info
    };
    // Color the *terminal* logs by level. Only the Stdout target gets ANSI; the
    // LogDir target stays plain so the file (and DiagnosticsSnapshot's
    // recentLogLines) never contains escape codes.
    let log_colors = tauri_plugin_log::fern::colors::ColoredLevelConfig::new()
        .error(tauri_plugin_log::fern::colors::Color::Red)
        .warn(tauri_plugin_log::fern::colors::Color::Yellow)
        .info(tauri_plugin_log::fern::colors::Color::Green)
        .debug(tauri_plugin_log::fern::colors::Color::Blue)
        .trace(tauri_plugin_log::fern::colors::Color::BrightBlack);
    let mut builder = tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log_level)
                .level_for("macroni::observability", log::LevelFilter::Debug)
                .max_file_size(5_000_000)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(5))
                // Neutralize the plugin's default parent format. fern chains the
                // parent format INTO each target's format, so leaving the default
                // here would prepend "[date][time][target][level]" before our
                // per-target formats run — producing a doubled prefix. Pass the
                // raw message through and let each target format it once.
                .format(|out, message, _record| out.finish(format_args!("{message}")))
                .targets([
                    // Terminal: dim timestamp + target, colored level. ANSI here only.
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout).format(
                        move |out, message, record| {
                            out.finish(format_args!(
                                "\x1b[2m{}\x1b[0m [{}] \x1b[2m{}\x1b[0m {}",
                                chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f"),
                                log_colors.color(record.level()),
                                record.target(),
                                message
                            ))
                        },
                    ),
                    // File: plain, no ANSI — matches the plugin's default format
                    // (UTC) so the rotating log and DiagnosticsSnapshot stay clean.
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: None,
                    })
                    .format(|out, message, record| {
                        out.finish(format_args!(
                            "{}[{}][{}] {}",
                            chrono::Utc::now().format("[%Y-%m-%d][%H:%M:%S]"),
                            record.target(),
                            record.level(),
                            message
                        ))
                    }),
                ])
                .build(),
        )
        .plugin(tauri_plugin_opener::init());

    // Initialize nspanel plugin on macOS (MUST be before setup)
    #[cfg(target_os = "macos")]
    {
        builder = builder.plugin(tauri_nspanel::init());
    }

    let builder = builder
        .setup(move |app| {
            observability::init(app.handle());
            observability::log_info("app", "setup.start", None);

            // Register global shortcuts inside setup using the correct Tauri v2 pattern.
            // `CommandOrControl` maps to Cmd on macOS and Ctrl elsewhere; using
            // `super` on Windows maps to the Windows key, where Win+R/Win+M are reserved.
            #[cfg(desktop)]
            {
                use tauri_plugin_global_shortcut::{Code, Modifiers, ShortcutState};

                let primary_modifier = if cfg!(target_os = "macos") {
                    Modifiers::SUPER
                } else {
                    Modifiers::CONTROL
                };
                let shortcut_builder =
                    tauri_plugin_global_shortcut::Builder::new().with_shortcuts([
                        "CommandOrControl+M",
                        "CommandOrControl+R",
                        "CommandOrControl+Shift+R",
                    ]);

                match shortcut_builder {
                    Ok(builder) => {
                        let plugin = builder
                            .with_handler({
                                let engine = Arc::clone(&shortcut_engine);
                                move |app, shortcut, event| {
                                    if event.state() != ShortcutState::Pressed {
                                        return;
                                    }

                                    // Cmd+M / Ctrl+M — toggle visibility.
                                    if shortcut.matches(primary_modifier, Code::KeyM) {
                                        observability::log_info(
                                            "shortcut",
                                            "toggle_visibility",
                                            None,
                                        );
                                        let _ = toggle_visibility(app.clone(), None);
                                    }
                                    // Cmd+R / Ctrl+R — toggle playback.
                                    // Stop directly in Rust to avoid frontend round-trip
                                    // latency and simulated keystrokes interfering with
                                    // the shortcut.
                                    else if shortcut.matches(primary_modifier, Code::KeyR) {
                                        if engine.is_playing() {
                                            observability::log_info(
                                                "shortcut",
                                                "stop_playback",
                                                None,
                                            );
                                            engine.stop();
                                            let _ = app.emit("playback-stopped", ());
                                        } else {
                                            observability::log_info(
                                                "shortcut",
                                                "toggle_playback",
                                                None,
                                            );
                                            let _ = app.emit("toggle-playback", ());
                                        }
                                    }
                                    // Cmd+Shift+R / Ctrl+Shift+R — toggle recording.
                                    // Stop is handled directly in Rust (stop +
                                    // auto-save + notify), NOT via a frontend
                                    // round-trip: the webview can be busy or
                                    // wedged, and a recording must always be
                                    // stoppable. Start still goes through the
                                    // frontend so its status stays in sync.
                                    else if shortcut
                                        .matches(primary_modifier | Modifiers::SHIFT, Code::KeyR)
                                    {
                                        let state = app.state::<RecordingState>();
                                        if state.session.is_active() {
                                            observability::log_info(
                                                "shortcut",
                                                "stop_recording",
                                                None,
                                            );
                                            // finish_recording joins the capture thread, whose
                                            // finalize muxes the whole MP4 — seconds for long
                                            // recordings. The shortcut handler fires on the main
                                            // run loop, so doing this inline would freeze the UI.
                                            // Run the whole stop+save+emit sequence off-thread;
                                            // is_active() above is a cheap atomic check that stays
                                            // synchronous, and the session state machine safely
                                            // rejects a concurrent double-stop.
                                            let app = app.clone();
                                            std::thread::spawn(move || {
                                                let state = app.state::<RecordingState>();
                                                match finish_recording(&app, &state) {
                                                    Ok(result) => {
                                                        let saved =
                                                            recordings_store::RecordingsStore::open(
                                                                &app,
                                                            )
                                                            .and_then(|s| {
                                                                s.save_stopped(
                                                                    result.id.clone(),
                                                                    result.events,
                                                                    result.video,
                                                                )
                                                            });
                                                        match saved {
                                                            Ok(recording) => {
                                                                let _ = app.emit(
                                                                    "recording-stopped",
                                                                    recording.map(|r| r.id),
                                                                );
                                                            }
                                                            Err(e) => {
                                                                observability::log_error(
                                                                    "recording",
                                                                    "shortcut_save_failed",
                                                                    &e.to_string(),
                                                                    Some(json!({
                                                                        "recordingId": result.id
                                                                    })),
                                                                );
                                                                let _ = app.emit(
                                                                    "recording-stopped",
                                                                    Option::<String>::None,
                                                                );
                                                            }
                                                        }
                                                    }
                                                    Err(e) => observability::log_error(
                                                        "recording",
                                                        "shortcut_stop_failed",
                                                        &e,
                                                        None,
                                                    ),
                                                }
                                            });
                                        } else {
                                            observability::log_info(
                                                "shortcut",
                                                "toggle_recording",
                                                None,
                                            );
                                            let _ = app.emit("toggle-recording", ());
                                        }
                                    }
                                }
                            })
                            .build();

                        if let Err(e) = app.handle().plugin(plugin) {
                            let message = format!("global shortcut plugin unavailable: {e}");
                            observability::log_warn(
                                "shortcut",
                                "plugin_unavailable",
                                &message,
                                None,
                            );
                            crash_log::log_line(&message);
                        }
                    }
                    Err(e) => {
                        let message = format!("global shortcut parse failed: {e}");
                        observability::log_warn("shortcut", "parse_failed", &message, None);
                        crash_log::log_line(&message);
                    }
                }
            }

            crash_log::log_line("setup: start");

            // Initialize macOS NSPanel configuration
            #[cfg(target_os = "macos")]
            init_macos_panel(app.app_handle());

            // Clean up orphaned video files from prior crashes.
            if let Ok(store) = recordings_store::RecordingsStore::open(app.app_handle()) {
                store.sweep_orphan_videos();
                store.sweep_orphan_perception();
            }
            if let Ok(store) = macros::store::MacroStore::open(app.app_handle()) {
                store.sweep_orphans();
            }

            crash_log::log_line("setup: complete");
            observability::log_info("app", "setup.complete", None);

            // Create a channel for sending events from listener thread
            let (tx, rx) = channel::<InputEvent>();

            // Clone the sender for the Space-switch watcher BEFORE the listener
            // thread moves `tx`. The watcher feeds SpaceSwitch events into the
            // same collector channel so they interleave with key/mouse events.
            #[cfg(target_os = "macos")]
            let space_tx = tx.clone();

            // Spawn thread to handle received events. Events accumulate only
            // on the Rust side (stop_recording returns them) — they are NOT
            // forwarded to the webview: per-event IPC + React work froze the
            // webview on long recordings, which also blocked the old
            // frontend-routed stop path.
            //
            // The collector also runs the keyboard-trigger dedup: a ⌃arrow /
            // F3 switch already replays via its captured key events, so the
            // NSWorkspace notification that fires alongside it would double the
            // Space change. Every KeyPress/KeyRelease updates the dedup state;
            // a SpaceSwitch within the window of such a trigger is dropped.
            let mut dedup = space_switch::SwitchDedup::new(500);
            std::thread::spawn(move || {
                while let Ok(event) = rx.recv() {
                    match &event {
                        InputEvent::KeyPress { key, timestamp } => {
                            dedup.note_key_press(key, *timestamp)
                        }
                        InputEvent::KeyRelease { key, .. } => dedup.note_key_release(key),
                        InputEvent::SpaceSwitch { timestamp, .. } => {
                            if !dedup.admit(*timestamp) {
                                continue; // ⌃arrow already recorded this switch
                            }
                        }
                        _ => {}
                    }
                    collector_session.push_event(event);
                }
            });

            // Spawn the input listener on a real OS thread.
            // On Windows, rdev::listen requires a thread with a message pump;
            // tokio async tasks don't provide one, causing an immediate crash.
            thread::spawn(move || {
                #[cfg(target_os = "macos")]
                rdev::set_is_main_thread(false);

                let mut capture = event_capture::EventCapture::new();
                let mut was_active = false;
                let callback = move |event: Event| {
                    let is_active = listener_session.is_active();
                    if !is_active {
                        was_active = false;
                        return;
                    }
                    if !was_active {
                        // Rising edge: a new session just started. Clear any
                        // modifier/button state left from the previous session —
                        // release events that fired while the listener was
                        // inactive were silently dropped and would otherwise
                        // poison this session (e.g. the user holds Cmd to fire
                        // the Cmd+Shift+R stop shortcut, releases Cmd after the
                        // session ended; without this reset every subsequent
                        // keypress would emit a stale KeyCombo).
                        capture.reset();
                        was_active = true;
                    }
                    let timestamp = Utc::now().timestamp_millis();
                    for ev in capture.on_rdev_event(event.event_type, timestamp) {
                        let _ = tx.send(ev);
                    }
                };

                if let Err(e) = listen(callback) {
                    observability::log_error("input", "listener_failed", &format!("{e:?}"), None);
                }
            });

            // Register the NSWorkspace active-space observer on the main thread.
            // It runs for the app's lifetime and only emits while a session is
            // active; the collector dedup drops keyboard-driven duplicates.
            #[cfg(target_os = "macos")]
            space_watch::install(space_tx, watcher_session);

            Ok(())
        })
        .manage(state);

    // Native studio preview surface (Phase 1, Task 11) — managed state (macOS).
    #[cfg(target_os = "macos")]
    let builder = builder.manage(preview_surface::StudioState::default());
    #[cfg(target_os = "macos")]
    let builder = builder.manage(permissions::PermissionDragState::default());
    #[cfg(target_os = "macos")]
    let builder = builder.manage(permissions::PermissionAssistantState::default());

    builder
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
            permissions::check_accessibility_permission,
            permissions::request_accessibility,
            permissions::install_permission_drag_region,
            permissions::remove_permission_drag_region,
            permissions::present_permission_assistant,
            permissions::present_permission_assistant_when_ready,
            permissions::refresh_permission_assistant,
            permissions::dismiss_permission_assistant,
            focus_studio_window,
            request_replay,
            get_app_data_dir,
            get_diagnostics_snapshot,
            project_store::studio_load_project,
            project_store::studio_save_project,
            studio_export::studio_export,
            perception::commands::extract_region,
            perception::commands::save_target,
            perception::commands::delete_target,
            perception::commands::load_observations,
            macros::commands::save_macro,
            macros::commands::load_macros,
            macros::commands::delete_macro,
            macros::commands::run_macro,
            macros::commands::stop_macro,
            // Native studio preview surface (Phase 1, Task 11) — macOS-only.
            #[cfg(target_os = "macos")]
            preview_surface::studio_attach_surface,
            #[cfg(target_os = "macos")]
            preview_surface::studio_open_preview,
            #[cfg(target_os = "macos")]
            preview_surface::studio_render_preview,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
