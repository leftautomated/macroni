//! `studio_export` — offscreen export of a recording to MP4.
//!
//! Spawns a worker thread that creates a headless [`render_core::engine::Engine`],
//! loads the saved [`render_core::doc::ProjectDoc`], and encodes every frame.
//! Progress / done / error are surfaced via Tauri events so the frontend can
//! display a progress bar without blocking.

use render_core::decode::Mp4FrameSource;
use render_core::doc::ProjectDoc;
use render_core::engine::Engine;
use tauri::{AppHandle, Emitter, Manager};

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
pub fn studio_export(app: AppHandle, recording_id: String) -> Result<String, String> {
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

    // Compute output path: <app_data>/exports/<recording_id>-<timestamp_ms>.mp4
    let exports_dir = app_data.join("exports");
    std::fs::create_dir_all(&exports_dir)
        .map_err(|e| format!("mkdir exports: {e}"))?;

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
    let thread_screen = screen_path.clone();

    std::thread::spawn(move || {
        // Fix #5: catch panics from Engine::new / engine.export so the frontend
        // never gets stuck in isExporting=true on an unexpected crash.
        let panic_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let result = (|| -> Result<(), String> {
                // Open decoder + build headless engine on this thread.
                // Mp4FrameSource is !Send, but it is created and consumed entirely on
                // this single worker thread, so this is safe.
                let src = Mp4FrameSource::open(std::path::Path::new(&thread_screen))
                    .map_err(|e| format!("open source: {e}"))?;
                let mut engine = Engine::new(Box::new(src))
                    .map_err(|e| format!("engine init: {e}"))?;

                engine
                    .export(&doc, &thread_out, |p| {
                        let _ = thread_app.emit("studio-export-progress", p);
                    })
                    .map_err(|e| format!("export: {e}"))?;

                Ok(())
            })();

            match result {
                Ok(()) => {
                    let _ = thread_app.emit(
                        "studio-export-done",
                        thread_out.to_string_lossy().into_owned(),
                    );
                }
                Err(e) => {
                    let _ = thread_app.emit("studio-export-error", e);
                }
            }
        }));

        if let Err(_) = panic_result {
            let _ = app.emit("studio-export-error", "export crashed".to_string());
        }
    });

    Ok(out_path_str)
}
