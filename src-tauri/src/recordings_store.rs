//! Persistence for `recordings.json` and its associated video files.
//!
//! Hides the on-disk JSON layout, parse-or-empty semantics, atomic writes, and
//! orphan video sweeping behind a small interface. Tauri commands become thin
//! dispatchers; tests use `open_at(tempdir)` to exercise the store without an
//! `AppHandle`.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

use crate::perception::{Observation, Target};
use crate::types::{InputEvent, Recording, VideoMetadata};

const RECORDINGS_FILENAME: &str = "recordings.json";
const VIDEOS_DIRNAME: &str = "videos";
const OBSERVATIONS_DIRNAME: &str = "observations";
const TARGETS_DIRNAME: &str = "targets";

#[derive(Debug)]
pub enum StoreError {
    Io(std::io::Error),
    Serde(serde_json::Error),
    NotFound,
    InvalidSpeed,
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StoreError::Io(e) => write!(f, "{}", e),
            StoreError::Serde(e) => write!(f, "{}", e),
            StoreError::NotFound => write!(f, "Recording not found"),
            StoreError::InvalidSpeed => write!(f, "Speed must be between 0.01 and 1000"),
        }
    }
}

impl From<std::io::Error> for StoreError {
    fn from(e: std::io::Error) -> Self {
        StoreError::Io(e)
    }
}
impl From<serde_json::Error> for StoreError {
    fn from(e: serde_json::Error) -> Self {
        StoreError::Serde(e)
    }
}

pub struct RecordingsStore {
    data_dir: PathBuf,
}

impl RecordingsStore {
    pub fn open(app: &AppHandle) -> Result<Self, StoreError> {
        let data_dir = app.path().app_data_dir().map_err(|e| {
            StoreError::Io(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                e.to_string(),
            ))
        })?;
        std::fs::create_dir_all(&data_dir)?;
        Ok(Self { data_dir })
    }

    #[allow(dead_code)] // test seam — referenced from #[cfg(test)] blocks only
    pub fn open_at(data_dir: PathBuf) -> Self {
        Self { data_dir }
    }

    fn recordings_path(&self) -> PathBuf {
        self.data_dir.join(RECORDINGS_FILENAME)
    }
    fn videos_dir(&self) -> PathBuf {
        self.data_dir.join(VIDEOS_DIRNAME)
    }
    fn video_path(&self, id: &str) -> PathBuf {
        self.videos_dir().join(format!("{}.mp4", id))
    }
    fn observations_path(&self, id: &str) -> PathBuf {
        self.data_dir
            .join(OBSERVATIONS_DIRNAME)
            .join(format!("{}.json", id))
    }
    pub fn targets_dir(&self, id: &str) -> PathBuf {
        self.data_dir.join(TARGETS_DIRNAME).join(id)
    }
    pub fn template_path(&self, id: &str, target_id: &str) -> PathBuf {
        self.targets_dir(id).join(format!("{}.png", target_id))
    }

    pub fn load_all(&self) -> Result<Vec<Recording>, StoreError> {
        let path = self.recordings_path();
        if !path.exists() {
            return Ok(Vec::new());
        }
        let content = std::fs::read_to_string(&path)?;
        match serde_json::from_str::<Vec<Recording>>(&content) {
            Ok(mut list) => {
                // Upgrade legacy line-unit scroll deltas to pixels so replay
                // (which emits pixel-unit wheel events) matches magnitude.
                for recording in &mut list {
                    recording.normalize_scroll_units();
                }
                Ok(list)
            }
            Err(e) => {
                crate::observability::log_warn(
                    "recordings_store",
                    "recordings_json_unreadable",
                    &format!("{} unreadable, treating as empty: {e}", path.display()),
                    None,
                );
                Ok(Vec::new())
            }
        }
    }

    /// Persist a just-stopped recording under the default name — the same
    /// auto-save the frontend performs after `stop_recording`. Used by the
    /// Rust-side shortcut stop path, which cannot rely on the webview being
    /// responsive. Returns `None` (writing nothing) when the session captured
    /// neither events nor video.
    pub fn save_stopped(
        &self,
        id: String,
        events: Vec<InputEvent>,
        video: Option<VideoMetadata>,
    ) -> Result<Option<Recording>, StoreError> {
        if events.is_empty() && video.is_none() {
            return Ok(None);
        }
        self.add(Recording {
            id,
            name: "Untitled".to_string(),
            events,
            created_at: chrono::Utc::now().timestamp_millis(),
            playback_speed: 1.0,
            scroll_unit: crate::types::ScrollUnit::Pixels,
            video,
            targets: Vec::new(),
        })
        .map(Some)
    }

    pub fn add(&self, recording: Recording) -> Result<Recording, StoreError> {
        let mut recordings = self.load_all()?;
        recordings.push(recording.clone());
        self.write_all(&recordings)?;
        Ok(recording)
    }

    pub fn delete(&self, id: &str) -> Result<(), StoreError> {
        let mut recordings = self.load_all()?;
        let before = recordings.len();
        recordings.retain(|r| r.id != id);
        if recordings.len() == before {
            return Err(StoreError::NotFound);
        }
        self.write_all(&recordings)?;
        let _ = std::fs::remove_file(self.video_path(id));
        let _ = std::fs::remove_file(self.observations_path(id));
        let _ = std::fs::remove_dir_all(self.targets_dir(id));
        Ok(())
    }

    pub fn update_name(&self, id: &str, name: &str) -> Result<Recording, StoreError> {
        let mut recordings = self.load_all()?;
        let target = recordings
            .iter_mut()
            .find(|r| r.id == id)
            .ok_or(StoreError::NotFound)?;
        target.name = name.to_string();
        let updated = target.clone();
        self.write_all(&recordings)?;
        Ok(updated)
    }

    pub fn update_speed(&self, id: &str, speed: f64) -> Result<Recording, StoreError> {
        // The Display impl for InvalidSpeed promises the range [0.01, 1000];
        // the frontend may match on that string. Reject anything below 0.01
        // (including subnormals) or above 1000.
        if !speed.is_finite() || !(0.01..=1000.0).contains(&speed) {
            return Err(StoreError::InvalidSpeed);
        }
        let mut recordings = self.load_all()?;
        let target = recordings
            .iter_mut()
            .find(|r| r.id == id)
            .ok_or(StoreError::NotFound)?;
        target.playback_speed = speed;
        let updated = target.clone();
        self.write_all(&recordings)?;
        Ok(updated)
    }

    pub fn write_observations(&self, id: &str, obs: &[Observation]) -> Result<(), StoreError> {
        let path = self.observations_path(id);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let content = serde_json::to_string(obs)?;
        atomic_write(&path, content.as_bytes())
    }

    pub fn load_observations(&self, id: &str) -> Result<Vec<Observation>, StoreError> {
        let path = self.observations_path(id);
        if !path.exists() {
            return Ok(Vec::new());
        }
        let content = std::fs::read_to_string(&path)?;
        match serde_json::from_str::<Vec<Observation>>(&content) {
            Ok(list) => Ok(list),
            Err(e) => {
                crate::observability::log_warn(
                    "recordings_store",
                    "observations_json_unreadable",
                    &format!("{} unreadable, treating as empty: {e}", path.display()),
                    None,
                );
                Ok(Vec::new())
            }
        }
    }

    /// Add `target` to the recording's target list, replacing any existing
    /// target with the same id.
    pub fn add_target(&self, id: &str, target: Target) -> Result<Recording, StoreError> {
        let mut recordings = self.load_all()?;
        let rec = recordings
            .iter_mut()
            .find(|r| r.id == id)
            .ok_or(StoreError::NotFound)?;
        rec.targets.retain(|t| t.id != target.id);
        rec.targets.push(target);
        let updated = rec.clone();
        self.write_all(&recordings)?;
        Ok(updated)
    }

    /// Remove the target with `target_id` from the recording, and
    /// best-effort delete its template PNG (if any).
    pub fn remove_target(&self, id: &str, target_id: &str) -> Result<Recording, StoreError> {
        let mut recordings = self.load_all()?;
        let rec = recordings
            .iter_mut()
            .find(|r| r.id == id)
            .ok_or(StoreError::NotFound)?;
        let before = rec.targets.len();
        rec.targets.retain(|t| t.id != target_id);
        if rec.targets.len() == before {
            return Err(StoreError::NotFound);
        }
        let updated = rec.clone();
        self.write_all(&recordings)?;
        let _ = std::fs::remove_file(self.template_path(id, target_id));
        Ok(updated)
    }

    /// Remove `videos/*.mp4` files whose id doesn't match any saved recording.
    pub fn sweep_orphan_videos(&self) {
        let videos_dir = self.videos_dir();
        if !videos_dir.exists() {
            return;
        }
        let known_ids: std::collections::HashSet<String> = match self.load_all() {
            Ok(list) => list.into_iter().map(|r| r.id).collect(),
            Err(_) => return,
        };
        let Ok(entries) = std::fs::read_dir(&videos_dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("mp4") {
                continue;
            }
            let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            if !known_ids.contains(stem) {
                let _ = std::fs::remove_file(&path);
            }
        }
    }

    /// Remove `observations/*.json` files and `targets/*` directories whose
    /// id doesn't match any saved recording.
    pub fn sweep_orphan_perception(&self) {
        let known_ids: std::collections::HashSet<String> = match self.load_all() {
            Ok(list) => list.into_iter().map(|r| r.id).collect(),
            Err(_) => return,
        };

        let observations_dir = self.data_dir.join(OBSERVATIONS_DIRNAME);
        if let Ok(entries) = std::fs::read_dir(&observations_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|s| s.to_str()) != Some("json") {
                    continue;
                }
                let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
                    continue;
                };
                if !known_ids.contains(stem) {
                    let _ = std::fs::remove_file(&path);
                }
            }
        }

        let targets_dir = self.data_dir.join(TARGETS_DIRNAME);
        if let Ok(entries) = std::fs::read_dir(&targets_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_dir() {
                    continue;
                }
                let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
                    continue;
                };
                if !known_ids.contains(name) {
                    let _ = std::fs::remove_dir_all(&path);
                }
            }
        }
    }

    fn write_all(&self, recordings: &[Recording]) -> Result<(), StoreError> {
        std::fs::create_dir_all(&self.data_dir)?;
        let final_path = self.recordings_path();
        let content = serde_json::to_string_pretty(recordings)?;
        atomic_write(&final_path, content.as_bytes())
    }
}

/// Write to a sibling temp file then rename — prevents truncated/corrupt JSON
/// if the process dies mid-write.
fn atomic_write(final_path: &Path, bytes: &[u8]) -> Result<(), StoreError> {
    let dir = final_path.parent().ok_or_else(|| {
        StoreError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "no parent dir",
        ))
    })?;
    let file_name = final_path
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| {
            StoreError::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "no file name",
            ))
        })?;
    let tmp_path = dir.join(format!(".{}.tmp", file_name));
    std::fs::write(&tmp_path, bytes)?;
    std::fs::rename(&tmp_path, final_path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{InputEvent, ScrollUnit};
    use tempfile::tempdir;

    fn rec(id: &str, name: &str) -> Recording {
        Recording {
            id: id.into(),
            name: name.into(),
            events: vec![InputEvent::KeyPress {
                key: "A".into(),
                timestamp: 1,
            }],
            created_at: 1_700_000_000_000,
            playback_speed: 1.0,
            scroll_unit: ScrollUnit::Pixels,
            video: None,
            targets: Vec::new(),
        }
    }

    #[test]
    fn load_all_returns_empty_when_file_missing() {
        let dir = tempdir().unwrap();
        let store = RecordingsStore::open_at(dir.path().to_path_buf());
        assert_eq!(store.load_all().unwrap().len(), 0);
    }

    #[test]
    fn add_round_trips_through_load_all() {
        let dir = tempdir().unwrap();
        let store = RecordingsStore::open_at(dir.path().to_path_buf());
        store.add(rec("1", "first")).unwrap();
        store.add(rec("2", "second")).unwrap();
        let all = store.load_all().unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].id, "1");
        assert_eq!(all[1].name, "second");
    }

    #[test]
    fn update_name_preserves_other_fields() {
        let dir = tempdir().unwrap();
        let store = RecordingsStore::open_at(dir.path().to_path_buf());
        store.add(rec("1", "old")).unwrap();
        let updated = store.update_name("1", "new").unwrap();
        assert_eq!(updated.name, "new");
        assert_eq!(updated.events.len(), 1);
        assert_eq!(updated.playback_speed, 1.0);
        assert_eq!(store.load_all().unwrap()[0].name, "new");
    }

    #[test]
    fn update_name_missing_id_returns_not_found() {
        let dir = tempdir().unwrap();
        let store = RecordingsStore::open_at(dir.path().to_path_buf());
        store.add(rec("1", "x")).unwrap();
        assert!(matches!(
            store.update_name("nope", "y"),
            Err(StoreError::NotFound)
        ));
    }

    #[test]
    fn update_speed_rejects_nonfinite_zero_negative_and_too_large() {
        let dir = tempdir().unwrap();
        let store = RecordingsStore::open_at(dir.path().to_path_buf());
        store.add(rec("1", "x")).unwrap();
        assert!(matches!(
            store.update_speed("1", f64::NAN),
            Err(StoreError::InvalidSpeed)
        ));
        assert!(matches!(
            store.update_speed("1", 0.0),
            Err(StoreError::InvalidSpeed)
        ));
        assert!(matches!(
            store.update_speed("1", -1.0),
            Err(StoreError::InvalidSpeed)
        ));
        assert!(matches!(
            store.update_speed("1", 1001.0),
            Err(StoreError::InvalidSpeed)
        ));
        assert!(matches!(
            store.update_speed("1", f64::INFINITY),
            Err(StoreError::InvalidSpeed)
        ));
    }

    #[test]
    fn update_speed_accepts_valid_range() {
        let dir = tempdir().unwrap();
        let store = RecordingsStore::open_at(dir.path().to_path_buf());
        store.add(rec("1", "x")).unwrap();
        let updated = store.update_speed("1", 2.5).unwrap();
        assert_eq!(updated.playback_speed, 2.5);
    }

    #[test]
    fn update_speed_rejects_values_between_zero_and_0_01_to_match_display_contract() {
        // The InvalidSpeed Display string promises "between 0.01 and 1000".
        // Values in (0.0, 0.01) used to be accepted under the old `<= 0.0`
        // guard, contradicting the contract.
        let dir = tempdir().unwrap();
        let store = RecordingsStore::open_at(dir.path().to_path_buf());
        store.add(rec("1", "x")).unwrap();
        assert!(matches!(
            store.update_speed("1", 0.001),
            Err(StoreError::InvalidSpeed)
        ));
        assert!(matches!(
            store.update_speed("1", 0.0001),
            Err(StoreError::InvalidSpeed)
        ));
        assert!(matches!(
            store.update_speed("1", f64::MIN_POSITIVE),
            Err(StoreError::InvalidSpeed)
        ));
        // 0.01 itself is the inclusive lower bound — must pass.
        assert!(store.update_speed("1", 0.01).is_ok());
    }

    #[test]
    fn update_speed_boundary_1000_is_inclusive_but_1000_001_is_not() {
        // The boundary is "speed > 1000.0 is invalid"; 1000.0 itself must be
        // accepted. Pins the > vs >= choice.
        let dir = tempdir().unwrap();
        let store = RecordingsStore::open_at(dir.path().to_path_buf());
        store.add(rec("1", "x")).unwrap();
        let exact = store.update_speed("1", 1000.0).unwrap();
        assert_eq!(exact.playback_speed, 1000.0);
        assert!(matches!(
            store.update_speed("1", 1000.0001),
            Err(StoreError::InvalidSpeed)
        ));
    }

    #[test]
    fn store_error_display_messages_are_stable() {
        // Error strings cross the Tauri boundary; the frontend may match on
        // them. Asserting protects against silent rewording.
        assert_eq!(StoreError::NotFound.to_string(), "Recording not found");
        assert_eq!(
            StoreError::InvalidSpeed.to_string(),
            "Speed must be between 0.01 and 1000"
        );
    }

    #[test]
    fn delete_removes_recording_and_associated_video_file() {
        let dir = tempdir().unwrap();
        let store = RecordingsStore::open_at(dir.path().to_path_buf());
        store.add(rec("1", "x")).unwrap();
        std::fs::create_dir_all(dir.path().join("videos")).unwrap();
        let video = dir.path().join("videos/1.mp4");
        std::fs::write(&video, b"fake").unwrap();
        store.delete("1").unwrap();
        assert_eq!(store.load_all().unwrap().len(), 0);
        assert!(!video.exists());
    }

    #[test]
    fn delete_missing_id_returns_not_found() {
        let dir = tempdir().unwrap();
        let store = RecordingsStore::open_at(dir.path().to_path_buf());
        store.add(rec("1", "x")).unwrap();
        assert!(matches!(store.delete("nope"), Err(StoreError::NotFound)));
    }

    #[test]
    fn sweep_orphan_videos_removes_unknown_mp4s_only() {
        let dir = tempdir().unwrap();
        let store = RecordingsStore::open_at(dir.path().to_path_buf());
        store.add(rec("keep", "x")).unwrap();
        std::fs::create_dir_all(dir.path().join("videos")).unwrap();
        let kept = dir.path().join("videos/keep.mp4");
        let orphan = dir.path().join("videos/orphan.mp4");
        let unrelated = dir.path().join("videos/notes.txt");
        std::fs::write(&kept, b"k").unwrap();
        std::fs::write(&orphan, b"o").unwrap();
        std::fs::write(&unrelated, b"n").unwrap();
        store.sweep_orphan_videos();
        assert!(kept.exists(), "known recording's video should remain");
        assert!(!orphan.exists(), "orphan mp4 should be removed");
        assert!(unrelated.exists(), "non-mp4 should be left alone");
    }

    #[test]
    fn save_stopped_persists_untitled_and_skips_empty_sessions() {
        let dir = tempdir().unwrap();
        let store = RecordingsStore::open_at(dir.path().to_path_buf());
        // Nothing captured -> nothing saved, nothing written.
        assert!(store
            .save_stopped("empty".into(), Vec::new(), None)
            .unwrap()
            .is_none());
        assert_eq!(store.load_all().unwrap().len(), 0);
        // Events captured -> saved under the default name with defaults.
        let saved = store
            .save_stopped(
                "1".into(),
                vec![InputEvent::KeyPress {
                    key: "A".into(),
                    timestamp: 1,
                }],
                None,
            )
            .unwrap()
            .expect("session with events must be saved");
        assert_eq!(saved.name, "Untitled");
        assert_eq!(saved.playback_speed, 1.0);
        assert!(saved.targets.is_empty());
        let all = store.load_all().unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].id, "1");
    }

    #[test]
    fn atomic_write_leaves_no_temp_file_on_success() {
        let dir = tempdir().unwrap();
        let store = RecordingsStore::open_at(dir.path().to_path_buf());
        store.add(rec("1", "x")).unwrap();
        let entries: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        for name in &entries {
            assert!(!name.ends_with(".tmp"), "stray temp file: {}", name);
        }
        assert!(entries.iter().any(|n| n == "recordings.json"));
    }

    #[test]
    fn legacy_recording_without_scroll_unit_loads_with_pixel_scaled_deltas() {
        // Files written before the pixel-delta capture fix have no
        // scroll_unit field and store coarse line deltas. Loading must scale
        // them to pixels (x10) so replay magnitude matches.
        let dir = tempdir().unwrap();
        let legacy = r#"[{
            "id": "old",
            "name": "legacy",
            "events": [
                {"type": "Scroll", "delta_x": 2, "delta_y": -3, "timestamp": 1},
                {"type": "KeyPress", "key": "A", "timestamp": 2}
            ],
            "created_at": 1700000000000
        }]"#;
        std::fs::write(dir.path().join("recordings.json"), legacy).unwrap();
        let store = RecordingsStore::open_at(dir.path().to_path_buf());
        let all = store.load_all().unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].scroll_unit, ScrollUnit::Pixels);
        match &all[0].events[0] {
            InputEvent::Scroll {
                delta_x, delta_y, ..
            } => {
                assert_eq!(*delta_x, 20);
                assert_eq!(*delta_y, -30);
            }
            other => panic!("expected Scroll, got {:?}", other),
        }
    }

    #[test]
    fn pixel_unit_recording_round_trips_without_rescaling() {
        // A recording saved after the fix must not be scaled again on load —
        // normalization is idempotent via the scroll_unit marker.
        let dir = tempdir().unwrap();
        let store = RecordingsStore::open_at(dir.path().to_path_buf());
        let mut r = rec("1", "pixels");
        r.events = vec![InputEvent::Scroll {
            delta_x: 7,
            delta_y: -40,
            timestamp: 1,
        }];
        store.add(r).unwrap();
        // Load twice to prove repeated loads don't compound.
        for _ in 0..2 {
            let all = store.load_all().unwrap();
            match &all[0].events[0] {
                InputEvent::Scroll {
                    delta_x, delta_y, ..
                } => {
                    assert_eq!(*delta_x, 7);
                    assert_eq!(*delta_y, -40);
                }
                other => panic!("expected Scroll, got {:?}", other),
            }
        }
    }

    #[test]
    fn save_stopped_tags_recordings_as_pixel_units() {
        let dir = tempdir().unwrap();
        let store = RecordingsStore::open_at(dir.path().to_path_buf());
        let saved = store
            .save_stopped(
                "1".into(),
                vec![InputEvent::Scroll {
                    delta_x: 5,
                    delta_y: 5,
                    timestamp: 1,
                }],
                None,
            )
            .unwrap()
            .expect("session with events must be saved");
        assert_eq!(saved.scroll_unit, ScrollUnit::Pixels);
    }

    #[test]
    fn corrupt_recordings_json_loads_as_empty() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("recordings.json"), b"not-json{").unwrap();
        let store = RecordingsStore::open_at(dir.path().to_path_buf());
        assert_eq!(store.load_all().unwrap().len(), 0);
    }

    #[test]
    fn observations_sidecar_round_trips_and_missing_reads_empty() {
        use crate::perception::{Observation, ObservationResult};
        let dir = tempdir().unwrap();
        let store = RecordingsStore::open_at(dir.path().to_path_buf());
        assert!(store.load_observations("none").unwrap().is_empty());
        let obs = vec![Observation {
            target_id: None,
            timestamp_ms: 500,
            result: ObservationResult::Color {
                rgb: [1, 2, 3],
                matched: true,
            },
        }];
        store.write_observations("1", &obs).unwrap();
        assert_eq!(store.load_observations("1").unwrap(), obs);
    }

    #[test]
    fn add_and_remove_target_update_recording() {
        use crate::perception::{Modality, Region, Target, TargetKind};
        let dir = tempdir().unwrap();
        let store = RecordingsStore::open_at(dir.path().to_path_buf());
        store.add(rec("1", "x")).unwrap();
        let t = Target {
            id: "t1".into(),
            name: "Submit".into(),
            modality: Modality::Visual,
            region: Some(Region {
                x: 0.1,
                y: 0.1,
                w: 0.2,
                h: 0.1,
            }),
            kind: TargetKind::TextOcr { expect: None },
            created_at: 1,
        };
        let updated = store.add_target("1", t.clone()).unwrap();
        assert_eq!(updated.targets.len(), 1);
        // Same id replaces, not duplicates.
        let updated = store.add_target("1", t.clone()).unwrap();
        assert_eq!(updated.targets.len(), 1);
        let updated = store.remove_target("1", "t1").unwrap();
        assert!(updated.targets.is_empty());
        assert!(matches!(
            store.remove_target("1", "t1"),
            Err(StoreError::NotFound)
        ));
    }

    #[test]
    fn delete_removes_sidecar_and_targets_dir() {
        let dir = tempdir().unwrap();
        let store = RecordingsStore::open_at(dir.path().to_path_buf());
        store.add(rec("1", "x")).unwrap();
        store.write_observations("1", &[]).unwrap();
        std::fs::create_dir_all(store.targets_dir("1")).unwrap();
        std::fs::write(store.template_path("1", "t1"), b"png").unwrap();
        store.delete("1").unwrap();
        assert!(!dir.path().join("observations/1.json").exists());
        assert!(!store.targets_dir("1").exists());
    }

    #[test]
    fn sweep_orphan_perception_prunes_unknown_ids_only() {
        let dir = tempdir().unwrap();
        let store = RecordingsStore::open_at(dir.path().to_path_buf());
        store.add(rec("keep", "x")).unwrap();
        store.write_observations("keep", &[]).unwrap();
        store.write_observations("orphan", &[]).unwrap();
        std::fs::create_dir_all(store.targets_dir("keep")).unwrap();
        std::fs::create_dir_all(store.targets_dir("orphan")).unwrap();
        store.sweep_orphan_perception();
        assert!(dir.path().join("observations/keep.json").exists());
        assert!(!dir.path().join("observations/orphan.json").exists());
        assert!(store.targets_dir("keep").exists());
        assert!(!store.targets_dir("orphan").exists());
    }
}
