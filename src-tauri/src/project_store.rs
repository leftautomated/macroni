//! Persistence for per-recording `ProjectDoc` sibling files.
//!
//! Each recording gets a `<app_data>/projects/<recording_id>.project.json`
//! file written atomically (temp + rename), mirroring `recordings_store.rs`.
//! Tauri commands are thin wrappers over the pure functions below; the pure
//! functions are fully unit-testable without an `AppHandle`.

use std::path::{Path, PathBuf};

use render_core::doc::ProjectDoc;
use serde_json::json;
use tauri::{AppHandle, Manager};

use crate::observability;
use crate::recordings_store::RecordingsStore;

const PROJECTS_DIRNAME: &str = "projects";

/// Returns the canonical path for a recording's project doc.
pub fn project_path(app_data: &Path, recording_id: &str) -> PathBuf {
    app_data
        .join(PROJECTS_DIRNAME)
        .join(format!("{}.project.json", recording_id))
}

/// Load the saved `ProjectDoc` for `recording_id`, if it exists.
///
/// Returns `Ok(None)` when no file is present yet; `Err` on I/O or parse
/// failure.
pub fn load_project(app_data: &Path, recording_id: &str) -> Result<Option<ProjectDoc>, String> {
    let path = project_path(app_data, recording_id);
    if !path.exists() {
        return Ok(None);
    }
    let content =
        std::fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let doc = serde_json::from_str::<ProjectDoc>(&content)
        .map_err(|e| format!("parse {}: {e}", path.display()))?;
    Ok(Some(doc))
}

/// Atomically persist `doc` as the project file for `recording_id`.
///
/// Creates `<app_data>/projects/` if it does not exist. Uses the same
/// temp-then-rename strategy as `recordings_store.rs` to prevent truncated
/// JSON if the process dies mid-write.
pub fn save_project(app_data: &Path, recording_id: &str, doc: &ProjectDoc) -> Result<(), String> {
    let path = project_path(app_data, recording_id);
    let dir = path.parent().expect("project_path always has a parent");
    std::fs::create_dir_all(dir).map_err(|e| format!("mkdir {}: {e}", dir.display()))?;
    let content =
        serde_json::to_string_pretty(doc).map_err(|e| format!("serialize project: {e}"))?;
    atomic_write(&path, content.as_bytes())
}

/// Write `bytes` to `final_path` via a sibling `.tmp` file, then rename.
fn atomic_write(final_path: &Path, bytes: &[u8]) -> Result<(), String> {
    let dir = final_path
        .parent()
        .ok_or_else(|| "no parent dir".to_string())?;
    let file_name = final_path
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "no file name".to_string())?;
    let tmp_path = dir.join(format!(".{}.tmp", file_name));
    std::fs::write(&tmp_path, bytes)
        .map_err(|e| format!("write temp {}: {e}", tmp_path.display()))?;
    std::fs::rename(&tmp_path, final_path)
        .map_err(|e| format!("rename to {}: {e}", final_path.display()))?;
    Ok(())
}

// ── Tauri commands ────────────────────────────────────────────────────────────

/// Load the `ProjectDoc` for `recording_id`.
///
/// If no project file exists yet, constructs a default from the recording's
/// `VideoMetadata.path`, saves it for stability, and returns it. Returns
/// `Err` if the recording is not found or I/O fails.
#[tauri::command]
pub fn studio_load_project(
    app_handle: AppHandle,
    recording_id: String,
    trace_id: Option<String>,
) -> Result<ProjectDoc, String> {
    let fields = json!({ "recordingId": recording_id });
    observability::trace_command("studio_load_project", trace_id, Some(fields), || {
        let app_data = app_handle
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?;

        // Return the persisted doc if it already exists.
        if let Some(doc) = load_project(&app_data, &recording_id)? {
            return Ok(doc);
        }

        // No saved doc yet — build a default from the recording's video path.
        let store = RecordingsStore::open(&app_handle).map_err(|e| e.to_string())?;
        let recordings = store.load_all().map_err(|e| e.to_string())?;
        let recording = recordings
            .iter()
            .find(|r| r.id == recording_id)
            .ok_or_else(|| format!("recording '{}' not found", recording_id))?;

        let screen_mp4 = recording
            .video
            .as_ref()
            .map(|v| v.path.clone())
            .unwrap_or_default();

        let doc = ProjectDoc::new_default(screen_mp4);

        // Persist the default so subsequent loads are stable.
        save_project(&app_data, &recording_id, &doc)?;

        Ok(doc)
    })
}

/// Persist `doc` as the project file for `recording_id`.
#[tauri::command]
pub fn studio_save_project(
    app_handle: AppHandle,
    recording_id: String,
    doc: ProjectDoc,
    trace_id: Option<String>,
) -> Result<(), String> {
    let fields = json!({ "recordingId": recording_id });
    observability::trace_command("studio_save_project", trace_id, Some(fields), || {
        let app_data = app_handle
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?;
        save_project(&app_data, &recording_id, &doc)
    })
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn default_doc(path: &str) -> ProjectDoc {
        ProjectDoc::new_default(path.to_string())
    }

    #[test]
    fn load_project_returns_none_when_file_missing() {
        let dir = tempdir().unwrap();
        let result = load_project(dir.path(), "missing-id").unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn save_then_load_round_trips_project_doc() {
        let dir = tempdir().unwrap();
        let doc = default_doc("/some/path/rec.mp4");
        save_project(dir.path(), "rec-1", &doc).unwrap();
        let loaded = load_project(dir.path(), "rec-1").unwrap().unwrap();
        assert_eq!(doc, loaded);
    }

    #[test]
    fn save_creates_projects_subdirectory() {
        let dir = tempdir().unwrap();
        let doc = default_doc("x.mp4");
        save_project(dir.path(), "abc", &doc).unwrap();
        assert!(dir.path().join("projects").is_dir());
    }

    #[test]
    fn project_path_uses_correct_filename() {
        let base = Path::new("/data");
        let p = project_path(base, "rec-42");
        assert_eq!(p, PathBuf::from("/data/projects/rec-42.project.json"));
    }

    #[test]
    fn atomic_write_leaves_no_tmp_file_on_success() {
        let dir = tempdir().unwrap();
        let doc = default_doc("y.mp4");
        save_project(dir.path(), "no-tmp", &doc).unwrap();
        let projects_dir = dir.path().join("projects");
        let entries: Vec<_> = std::fs::read_dir(&projects_dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        for name in &entries {
            assert!(!name.ends_with(".tmp"), "stray temp file found: {name}");
        }
        assert!(entries.iter().any(|n| n == "no-tmp.project.json"));
    }

    #[test]
    fn save_overwrites_existing_project_doc() {
        let dir = tempdir().unwrap();
        let doc1 = default_doc("v1.mp4");
        save_project(dir.path(), "over", &doc1).unwrap();

        let mut doc2 = default_doc("v2.mp4");
        doc2.version = 2;
        save_project(dir.path(), "over", &doc2).unwrap();

        let loaded = load_project(dir.path(), "over").unwrap().unwrap();
        assert_eq!(loaded.media.screen_mp4, "v2.mp4");
        assert_eq!(loaded.version, 2);
    }

    #[test]
    fn load_project_returns_err_on_corrupt_json() {
        let dir = tempdir().unwrap();
        let projects_dir = dir.path().join("projects");
        std::fs::create_dir_all(&projects_dir).unwrap();
        std::fs::write(projects_dir.join("bad.project.json"), b"not-json{").unwrap();
        assert!(load_project(dir.path(), "bad").is_err());
    }

    #[test]
    fn save_and_load_preserves_camel_case_json() {
        let dir = tempdir().unwrap();
        let doc = default_doc("cam.mp4");
        save_project(dir.path(), "cam-rec", &doc).unwrap();

        let raw =
            std::fs::read_to_string(dir.path().join("projects/cam-rec.project.json")).unwrap();
        assert!(
            raw.contains("screenMp4"),
            "JSON must use camelCase; got: {raw}"
        );
        assert!(
            raw.contains("paddingPx"),
            "JSON must use camelCase; got: {raw}"
        );
    }
}
