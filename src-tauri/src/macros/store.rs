//! Per-file persistence for `MacroDoc`s: one JSON file per macro under
//! `macros/{id}.json`, plus a per-macro `macros/{id}/assets/` directory that
//! holds copies of template-match PNGs so a macro is self-contained and can
//! outlive the recording it was carved from.
//!
//! Mirrors `recordings_store`'s open/open_at seam, atomic writes, and
//! parse-or-skip semantics.

use std::path::PathBuf;

use tauri::{AppHandle, Manager};

use crate::macros::MacroDoc;
use crate::perception::commands::is_safe_relative_path;
use crate::perception::TargetKind;
use crate::recordings_store::{atomic_write, validate_storage_id};

const MACROS_DIRNAME: &str = "macros";
const ASSETS_DIRNAME: &str = "assets";
const ASSETS_PREFIX: &str = "assets/";

pub struct MacroStore {
    data_dir: PathBuf,
}

impl MacroStore {
    pub fn open(app: &AppHandle) -> Result<Self, String> {
        let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
        std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
        Ok(Self { data_dir })
    }

    #[allow(dead_code)] // test seam — referenced from #[cfg(test)] blocks only
    pub fn open_at(data_dir: PathBuf) -> Self {
        Self { data_dir }
    }

    pub fn macros_dir(&self) -> PathBuf {
        self.data_dir.join(MACROS_DIRNAME)
    }

    fn doc_path(&self, id: &str) -> PathBuf {
        self.macros_dir().join(format!("{id}.json"))
    }

    fn macro_dir(&self, id: &str) -> PathBuf {
        self.macros_dir().join(id)
    }

    fn assets_dir(&self, id: &str) -> PathBuf {
        self.macro_dir(id).join(ASSETS_DIRNAME)
    }

    /// Read every `*.json` under `macros/`. A file that fails to parse is
    /// logged and skipped (forward-compat with future doc shapes) rather
    /// than failing the whole load.
    pub fn load_all(&self) -> Vec<MacroDoc> {
        let dir = self.macros_dir();
        let Ok(entries) = std::fs::read_dir(&dir) else {
            return Vec::new();
        };

        let mut out = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            let Ok(content) = std::fs::read_to_string(&path) else {
                continue;
            };
            match serde_json::from_str::<MacroDoc>(&content) {
                Ok(doc) => out.push(doc),
                Err(e) => {
                    crate::observability::log_warn(
                        "macros",
                        "macro_json_unreadable",
                        &format!("{} unreadable, skipping: {e}", path.display()),
                        None,
                    );
                }
            }
        }
        out
    }

    /// Validate ids, copy any not-yet-macro-relative template images into
    /// `macros/{id}/assets/` (rewriting `image` to point at the copy), then
    /// atomically write the doc. All validation — doc/rule id (path-traversal
    /// guard) and source-image existence — runs before any file is touched,
    /// so a rejected save leaves no trace on disk. An empty-rules doc saves
    /// fine (drafts); `validate_runnable` gates whether a doc can actually
    /// run, not whether it can be saved.
    pub fn save(&self, mut doc: MacroDoc) -> Result<MacroDoc, String> {
        validate_storage_id(&doc.id)?;

        // Pass 1: no side effects. Ids become path components and every
        // pending source must exist before the first copy lands, keeping
        // save all-or-nothing.
        for rule in &doc.rules {
            validate_storage_id(&rule.trigger.id)?;
            let TargetKind::TemplateMatch { image, .. } = &rule.trigger.kind else {
                continue;
            };
            if image.starts_with(ASSETS_PREFIX) {
                continue; // already macro-relative: idempotent re-save.
            }
            // Not yet macro-relative, so `image` is still webview-supplied
            // data about to be joined onto `data_dir` — reject any traversal
            // or absolute path before that join, let alone the copy below.
            if !is_safe_relative_path(image) {
                return Err("invalid template path".to_string());
            }
            let source = self.data_dir.join(image);
            if !source.exists() {
                return Err(format!("template image not found: {}", source.display()));
            }
        }

        // Pass 2: copy + rewrite.
        for rule in &mut doc.rules {
            let target = &mut rule.trigger;
            let TargetKind::TemplateMatch { image, .. } = &mut target.kind else {
                continue;
            };
            if image.starts_with(ASSETS_PREFIX) {
                continue;
            }

            let source = self.data_dir.join(&image);
            let assets_dir = self.assets_dir(&doc.id);
            std::fs::create_dir_all(&assets_dir).map_err(|e| e.to_string())?;
            let dest = assets_dir.join(format!("{}.png", target.id));
            std::fs::copy(&source, &dest).map_err(|e| e.to_string())?;
            *image = format!("{ASSETS_PREFIX}{}.png", target.id);
        }

        let path = self.doc_path(&doc.id);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let content = serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?;
        atomic_write(&path, content.as_bytes()).map_err(|e| e.to_string())?;
        Ok(doc)
    }

    /// Remove the doc's json and its `macros/{id}/` directory (assets and
    /// all). Errors if the doc doesn't exist.
    pub fn delete(&self, id: &str) -> Result<(), String> {
        validate_storage_id(id)?;
        let path = self.doc_path(id);
        if !path.exists() {
            return Err("Macro not found".to_string());
        }
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
        let _ = std::fs::remove_dir_all(self.macro_dir(id));
        Ok(())
    }

    /// Remove `macros/{id}/` directories that have no matching `{id}.json` —
    /// leftovers from a delete that was interrupted between the json removal
    /// and the dir removal, or from a save that copied assets before failing
    /// to write the json. Touches nothing else.
    pub fn sweep_orphans(&self) {
        let macros_dir = self.macros_dir();
        let Ok(entries) = std::fs::read_dir(&macros_dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
                continue;
            };
            if !macros_dir.join(format!("{name}.json")).exists() {
                let _ = std::fs::remove_dir_all(&path);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::macros::{MacroDoc, MacroRule, RuleAction};
    use crate::perception::{Modality, Region, Target, TargetKind};
    use crate::types::InputEvent;
    use tempfile::tempdir;

    fn play_rule(id: &str) -> MacroRule {
        MacroRule {
            id: id.into(),
            trigger: Target {
                id: format!("{id}-t"),
                name: "t".into(),
                modality: Modality::Visual,
                region: None,
                kind: TargetKind::TextOcr { expect: None },
                created_at: 1,
            },
            action: RuleAction::PlayInputs {
                events: vec![InputEvent::KeyPress {
                    key: "A".into(),
                    timestamp: 0,
                }],
                speed: 1.0,
                provenance: None,
            },
            enabled: true,
            anchor: None,
        }
    }

    fn rules_doc(id: &str) -> MacroDoc {
        MacroDoc {
            id: id.into(),
            name: "m".into(),
            rules: vec![play_rule("r1")],
            poll_interval_ms: 250,
            created_at: 1,
        }
    }

    fn template_rule(rule_id: &str, target_id: &str, image: &str) -> MacroRule {
        MacroRule {
            id: rule_id.into(),
            trigger: Target {
                id: target_id.into(),
                name: "t".into(),
                modality: Modality::Visual,
                region: Some(Region {
                    x: 0.0,
                    y: 0.0,
                    w: 0.5,
                    h: 0.5,
                }),
                kind: TargetKind::TemplateMatch {
                    image: image.into(),
                    threshold: 0.8,
                    source_px: [100, 100],
                },
                created_at: 1,
            },
            action: RuleAction::Stop,
            enabled: true,
            anchor: None,
        }
    }

    #[test]
    fn save_load_round_trips_and_skips_unreadable_files() {
        let dir = tempdir().unwrap();
        let store = MacroStore::open_at(dir.path().to_path_buf());
        store.save(rules_doc("m1")).unwrap();
        std::fs::write(dir.path().join("macros/broken.json"), b"{nope").unwrap();
        let all = store.load_all();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].id, "m1");
    }

    #[test]
    fn save_copies_template_assets_and_rewrites_paths() {
        let dir = tempdir().unwrap();
        // Simulate a recording's template at the perception layout.
        std::fs::create_dir_all(dir.path().join("targets/rec1")).unwrap();
        std::fs::write(dir.path().join("targets/rec1/t9.png"), b"png-bytes").unwrap();
        let store = MacroStore::open_at(dir.path().to_path_buf());
        let mut d = rules_doc("m2");
        d.rules
            .push(template_rule("r2", "t9", "targets/rec1/t9.png"));
        let saved = store.save(d).unwrap();
        assert!(dir.path().join("macros/m2/assets/t9.png").exists());
        match &saved.rules[1].trigger.kind {
            TargetKind::TemplateMatch { image, .. } => assert_eq!(image, "assets/t9.png"),
            other => panic!("{other:?}"),
        }
        // Saving again is idempotent (already assets/-relative: no re-copy, no error).
        assert!(store.save(saved).is_ok());
    }

    #[test]
    fn save_rejects_traversal_doc_id_and_writes_nothing() {
        let dir = tempdir().unwrap();
        let store = MacroStore::open_at(dir.path().to_path_buf());
        let mut d = rules_doc("placeholder");
        d.id = "../evil".into();
        assert!(store.save(d).is_err());
        // Nothing escaped the macros dir and nothing was written at all.
        assert!(!dir.path().join("evil.json").exists());
        assert!(!dir.path().join("macros").exists());
    }

    #[test]
    fn save_rejects_traversal_target_id_before_any_copy() {
        let dir = tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("targets/rec1")).unwrap();
        std::fs::write(dir.path().join("targets/rec1/t9.png"), b"png-bytes").unwrap();
        let store = MacroStore::open_at(dir.path().to_path_buf());
        let mut d = rules_doc("m9");
        d.rules
            .push(template_rule("r2", "../../x", "targets/rec1/t9.png"));
        assert!(store.save(d).is_err());
        assert!(!dir.path().join("macros/m9").exists());
        assert!(!dir.path().join("macros/m9.json").exists());
    }

    #[test]
    fn save_rejects_dot_dot_escape_in_image_and_writes_nothing() {
        let dir = tempdir().unwrap();
        let store = MacroStore::open_at(dir.path().to_path_buf());
        let mut d = rules_doc("m10");
        d.rules.push(template_rule("r2", "t9", "../../etc/passwd"));
        let err = store.save(d).unwrap_err();
        assert!(err.contains("invalid template path"), "{err}");
        assert!(!dir.path().join("macros/m10").exists());
        assert!(!dir.path().join("macros/m10.json").exists());
    }

    #[test]
    fn save_rejects_absolute_image_path_and_writes_nothing() {
        let dir = tempdir().unwrap();
        let store = MacroStore::open_at(dir.path().to_path_buf());
        let mut d = rules_doc("m11");
        d.rules.push(template_rule("r2", "t9", "/abs/path"));
        let err = store.save(d).unwrap_err();
        assert!(err.contains("invalid template path"), "{err}");
        assert!(!dir.path().join("macros/m11").exists());
        assert!(!dir.path().join("macros/m11.json").exists());
    }

    #[test]
    fn delete_rejects_traversal_id() {
        let dir = tempdir().unwrap();
        let store = MacroStore::open_at(dir.path().to_path_buf());
        assert!(store.delete("../evil").is_err());
    }

    #[test]
    fn save_with_missing_second_image_leaves_no_assets_dir() {
        // Two template rules; the SECOND one's source image is missing. The
        // existence pre-pass must fail before the first copy lands, so the
        // whole save is all-or-nothing.
        let dir = tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("targets/rec1")).unwrap();
        std::fs::write(dir.path().join("targets/rec1/t1.png"), b"png-bytes").unwrap();
        let store = MacroStore::open_at(dir.path().to_path_buf());
        let mut d = rules_doc("m4");
        d.rules
            .push(template_rule("r2", "t1", "targets/rec1/t1.png"));
        d.rules
            .push(template_rule("r3", "t2", "targets/rec1/missing.png"));
        let err = store.save(d).unwrap_err();
        assert!(err.contains("template image not found"), "{err}");
        assert!(!dir.path().join("macros/m4").exists());
        assert!(!dir.path().join("macros/m4.json").exists());
    }

    #[test]
    fn delete_removes_json_and_assets_dir() {
        let dir = tempdir().unwrap();
        let store = MacroStore::open_at(dir.path().to_path_buf());
        store.save(rules_doc("m3")).unwrap();
        std::fs::create_dir_all(dir.path().join("macros/m3/assets")).unwrap();
        store.delete("m3").unwrap();
        assert!(!dir.path().join("macros/m3.json").exists());
        assert!(!dir.path().join("macros/m3").exists());
        assert!(store.delete("m3").is_err());
    }

    #[test]
    fn sweep_removes_asset_dirs_without_json() {
        let dir = tempdir().unwrap();
        let store = MacroStore::open_at(dir.path().to_path_buf());
        store.save(rules_doc("keep")).unwrap();
        std::fs::create_dir_all(dir.path().join("macros/keep/assets")).unwrap();
        std::fs::create_dir_all(dir.path().join("macros/orphan/assets")).unwrap();
        store.sweep_orphans();
        assert!(dir.path().join("macros/keep").exists());
        assert!(!dir.path().join("macros/orphan").exists());
    }

    #[test]
    fn save_accepts_an_empty_rules_doc() {
        let dir = tempdir().unwrap();
        let store = MacroStore::open_at(dir.path().to_path_buf());
        let d = MacroDoc {
            id: "empty".into(),
            name: "m".into(),
            rules: vec![],
            poll_interval_ms: 250,
            created_at: 1,
        };
        store.save(d).unwrap();
        assert!(dir.path().join("macros/empty.json").exists());
    }

    #[test]
    fn load_all_skips_old_node_graph_docs() {
        let dir = tempdir().unwrap();
        let store = MacroStore::open_at(dir.path().to_path_buf());
        store.save(rules_doc("new1")).unwrap();
        std::fs::write(
            dir.path().join("macros/old.json"),
            br#"{"id":"old","name":"o","nodes":[],"edges":[],"created_at":1}"#,
        )
        .unwrap();
        let all = store.load_all();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].id, "new1");
    }
}
