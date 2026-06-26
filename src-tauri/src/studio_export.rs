//! `studio_export` — offscreen export of a recording to MP4.
//!
//! Spawns a worker thread that creates a headless [`render_core::engine::Engine`],
//! loads the saved [`render_core::doc::ProjectDoc`], and encodes every frame.
//! Progress / done / error are surfaced via Tauri events so the frontend can
//! display a progress bar without blocking.

use render_core::decode::Mp4FrameSource;
use render_core::doc::ProjectDoc;
use render_core::engine::Engine;
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};

use crate::observability;
use crate::project_store;
use crate::recordings_store::RecordingsStore;

/// Begin an offscreen export of `recording_id`.
///
/// Returns `Ok(out_path)` immediately after spawning the worker thread.
/// The worker emits:
///   - `studio-export-progress`  — `f32` in `(0, 1]`
///   - `studio-export-done`      — `String` (final output path)
///   - `studio-export-error`     — `String` (error message)
#[tauri::command]
pub fn studio_export(
    app: AppHandle,
    recording_id: String,
    trace_id: Option<String>,
) -> Result<String, String> {
    let fields = json!({ "recordingId": recording_id });
    observability::trace_command("studio_export", trace_id, Some(fields), || {
        let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;

        // Resolve the recording's screen mp4 path.
        let store = RecordingsStore::open(&app).map_err(|e| e.to_string())?;
        let recordings = store.load_all().map_err(|e| e.to_string())?;
        let recording = recordings
            .iter()
            .find(|r| r.id == recording_id)
            .ok_or_else(|| format!("recording '{}' not found", recording_id))?;

        // Fix #4: return a clear error instead of empty-string path when video is absent.
        let screen_path = recording
            .video
            .as_ref()
            .map(|v| v.path.clone())
            .ok_or_else(|| "recording has no video track".to_string())?;
        // VideoMetadata.path is relative to <app_data>/videos/ (see useVideoAssetUrl).
        let screen_file = app_data.join("videos").join(&screen_path);

        // Compute output path: <app_data>/exports/<recording_id>-<timestamp_ms>.mp4
        let exports_dir = app_data.join("exports");
        std::fs::create_dir_all(&exports_dir).map_err(|e| format!("mkdir exports: {e}"))?;

        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();

        let out_path = exports_dir.join(format!("{}-{}.mp4", recording_id, ts));
        let out_path_str = out_path.to_string_lossy().into_owned();

        // Load the project doc (or construct default) before entering the thread so
        // we can return an error synchronously if the recording is malformed.
        let doc = match project_store::load_project(&app_data, &recording_id)? {
            Some(d) => d,
            None => ProjectDoc::new_default(screen_path.clone()),
        };

        // Clone everything the thread needs.
        let thread_app = app.clone();
        let thread_out = out_path.clone();
        let thread_screen = screen_file;
        let thread_recording_id = recording_id.clone();

        std::thread::spawn(move || {
            let started_at = std::time::Instant::now();
            observability::log_info(
                "studio.export",
                "worker_started",
                Some(json!({
                    "recordingId": thread_recording_id,
                    "source": thread_screen.to_string_lossy(),
                    "output": thread_out.to_string_lossy(),
                })),
            );

            // Fix #5: catch panics from Engine::new / engine.export so the frontend
            // never gets stuck in isExporting=true on an unexpected crash.
            let panic_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let result = (|| -> Result<(), String> {
                    // Open decoder + build headless engine on this thread.
                    // Mp4FrameSource is !Send, but it is created and consumed entirely on
                    // this single worker thread, so this is safe.
                    let src = Mp4FrameSource::open(&thread_screen)
                        .map_err(|e| format!("open source '{}': {e}", thread_screen.display()))?;
                    let mut engine =
                        Engine::new(Box::new(src)).map_err(|e| format!("engine init: {e}"))?;

                    engine
                        .export(&doc, &thread_out, |p| {
                            let _ = thread_app.emit("studio-export-progress", p);
                        })
                        .map_err(|e| format!("export: {e}"))?;

                    Ok(())
                })();

                match result {
                    Ok(()) => {
                        observability::log_info(
                            "studio.export",
                            "worker_finished",
                            Some(json!({
                                "recordingId": thread_recording_id,
                                "durationMs": started_at.elapsed().as_secs_f64() * 1000.0,
                                "output": thread_out.to_string_lossy(),
                            })),
                        );
                        let _ = thread_app.emit(
                            "studio-export-done",
                            thread_out.to_string_lossy().into_owned(),
                        );
                    }
                    Err(e) => {
                        observability::log_error(
                            "studio.export",
                            "worker_failed",
                            &e,
                            Some(json!({
                                "recordingId": thread_recording_id,
                                "durationMs": started_at.elapsed().as_secs_f64() * 1000.0,
                            })),
                        );
                        let _ = thread_app.emit("studio-export-error", e);
                    }
                }
            }));

            if panic_result.is_err() {
                observability::log_error(
                    "studio.export",
                    "worker_panicked",
                    "export crashed",
                    Some(json!({ "recordingId": thread_recording_id })),
                );
                let _ = thread_app.emit("studio-export-error", "export crashed".to_string());
            }
        });

        Ok(out_path_str)
    })
}
