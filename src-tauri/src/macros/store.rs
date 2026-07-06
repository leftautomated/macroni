//! Per-file persistence for `MacroDoc`s: one JSON file per macro under
//! `macros/{id}.json`, plus a per-macro `macros/{id}/assets/` directory that
//! holds copies of template-match PNGs so a macro is self-contained and can
//! outlive the recording it was carved from.
//!
//! Mirrors `recordings_store`'s open/open_at seam, atomic writes, and
//! parse-or-skip semantics.

use std::path::PathBuf;

use tauri::{AppHandle, Manager};

use crate::macros::{chain_order, MacroDoc, MacroNodeKind};
use crate::perception::TargetKind;
use crate::recordings_store::{atomic_write, validate_storage_id};

const MACROS_DIRNAME: &str = "macros";
#[allow(dead_code)] // consumed by Task 6 (commands) via `save`
const ASSETS_DIRNAME: &str = "assets";
#[allow(dead_code)] // consumed by Task 6 (commands) via `save`
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

    #[allow(dead_code)] // consumed by Task 6 (commands) via `save`/`delete`
    fn doc_path(&self, id: &str) -> PathBuf {
        self.macros_dir().join(format!("{id}.json"))
    }

    #[allow(dead_code)] // consumed by Task 6 (commands) via `delete`/`assets_dir`
    fn macro_dir(&self, id: &str) -> PathBuf {
        self.macros_dir().join(id)
    }

    #[allow(dead_code)] // consumed by Task 6 (commands) via `save`
    fn assets_dir(&self, id: &str) -> PathBuf {
        self.macro_dir(id).join(ASSETS_DIRNAME)
    }

    /// Read every `*.json` under `macros/`. A file that fails to parse is
    /// logged and skipped (forward-compat with future doc shapes) rather
    /// than failing the whole load.
    #[allow(dead_code)] // consumed by Task 6 (commands)
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

    /// Validate the chain, copy any not-yet-macro-relative template images
    /// into `macros/{id}/assets/` (rewriting `image` to point at the copy),
    /// then atomically write the doc. All validation — ids (path-traversal
    /// guard), chain shape, and source-image existence — runs before any
    /// file is touched, so a rejected save leaves no trace on disk.
    #[allow(dead_code)] // consumed by Task 6 (commands)
    pub fn save(&self, mut doc: MacroDoc) -> Result<MacroDoc, String> {
        validate_storage_id(&doc.id)?;
        chain_order(&doc).map_err(|e| e.to_string())?;

        // Pass 1: no side effects. Ids become path components and every
        // pending source must exist before the first copy lands, keeping
        // save all-or-nothing.
        for node in &doc.nodes {
            let MacroNodeKind::WaitFor { target, .. } = &node.kind else {
                continue;
            };
            validate_storage_id(&target.id)?;
            let TargetKind::TemplateMatch { image, .. } = &target.kind else {
                continue;
            };
            if image.starts_with(ASSETS_PREFIX) {
                continue; // already macro-relative: idempotent re-save.
            }
            let source = self.data_dir.join(image);
            if !source.exists() {
                return Err(format!("template image not found: {}", source.display()));
            }
        }

        // Pass 2: copy + rewrite.
        for node in &mut doc.nodes {
            let MacroNodeKind::WaitFor { target, .. } = &mut node.kind else {
                continue;
            };
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
    #[allow(dead_code)] // consumed by Task 6 (commands)
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
    use crate::macros::{MacroDoc, MacroEdge, MacroNode, MacroNodeKind};
    use crate::perception::{Modality, Region, Target, TargetKind};
    use crate::types::InputEvent;
    use tempfile::tempdir;

    fn seg_doc(id: &str) -> MacroDoc {
        MacroDoc {
            id: id.into(),
            name: "m".into(),
            nodes: vec![MacroNode {
                id: "n1".into(),
                kind: MacroNodeKind::Segment {
                    events: vec![InputEvent::KeyPress {
                        key: "A".into(),
                        timestamp: 0,
                    }],
                    speed: 1.0,
                    provenance: None,
                },
                x: 0.0,
                y: 0.0,
            }],
            edges: vec![],
            created_at: 1,
        }
    }

    #[test]
    fn save_load_round_trips_and_skips_unreadable_files() {
        let dir = tempdir().unwrap();
        let store = MacroStore::open_at(dir.path().to_path_buf());
        store.save(seg_doc("m1")).unwrap();
        std::fs::write(dir.path().join("macros/broken.json"), b"{nope").unwrap();
        let all = store.load_all();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].id, "m1");
    }

    #[test]
    fn save_rejects_invalid_chains() {
        let dir = tempdir().unwrap();
        let store = MacroStore::open_at(dir.path().to_path_buf());
        let mut d = seg_doc("bad");
        d.edges.push(MacroEdge {
            from: "n1".into(),
            to: "ghost".into(),
        });
        assert!(store.save(d).is_err());
        assert!(!dir.path().join("macros/bad.json").exists());
    }

    #[test]
    fn save_copies_template_assets_and_rewrites_paths() {
        let dir = tempdir().unwrap();
        // Simulate a recording's template at the perception layout.
        std::fs::create_dir_all(dir.path().join("targets/rec1")).unwrap();
        std::fs::write(dir.path().join("targets/rec1/t9.png"), b"png-bytes").unwrap();
        let store = MacroStore::open_at(dir.path().to_path_buf());
        let mut d = seg_doc("m2");
        d.nodes.push(MacroNode {
            id: "n2".into(),
            kind: MacroNodeKind::WaitFor {
                target: Target {
                    id: "t9".into(),
                    name: "logo".into(),
                    modality: Modality::Visual,
                    region: Some(Region {
                        x: 0.0,
                        y: 0.0,
                        w: 0.5,
                        h: 0.5,
                    }),
                    kind: TargetKind::TemplateMatch {
                        image: "targets/rec1/t9.png".into(),
                        threshold: 0.8,
                        source_px: [100, 100],
                    },
                    created_at: 1,
                },
                timeout_ms: 10_000,
                poll_interval_ms: 500,
            },
            x: 0.0,
            y: 0.0,
        });
        d.edges.push(MacroEdge {
            from: "n1".into(),
            to: "n2".into(),
        });
        let saved = store.save(d).unwrap();
        assert!(dir.path().join("macros/m2/assets/t9.png").exists());
        match &saved.nodes[1].kind {
            MacroNodeKind::WaitFor { target, .. } => match &target.kind {
                TargetKind::TemplateMatch { image, .. } => assert_eq!(image, "assets/t9.png"),
                other => panic!("{other:?}"),
            },
            other => panic!("{other:?}"),
        }
        // Saving again is idempotent (already assets/-relative: no re-copy, no error).
        assert!(store.save(saved).is_ok());
    }

    fn wait_node(node_id: &str, target_id: &str, image: &str) -> MacroNode {
        MacroNode {
            id: node_id.into(),
            kind: MacroNodeKind::WaitFor {
                target: Target {
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
                timeout_ms: 10_000,
                poll_interval_ms: 500,
            },
            x: 0.0,
            y: 0.0,
        }
    }

    #[test]
    fn save_rejects_traversal_doc_id_and_writes_nothing() {
        let dir = tempdir().unwrap();
        let store = MacroStore::open_at(dir.path().to_path_buf());
        let mut d = seg_doc("placeholder");
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
        let mut d = seg_doc("m9");
        d.nodes
            .push(wait_node("n2", "../../x", "targets/rec1/t9.png"));
        d.edges.push(MacroEdge {
            from: "n1".into(),
            to: "n2".into(),
        });
        assert!(store.save(d).is_err());
        assert!(!dir.path().join("macros/m9").exists());
        assert!(!dir.path().join("macros/m9.json").exists());
    }

    #[test]
    fn delete_rejects_traversal_id() {
        let dir = tempdir().unwrap();
        let store = MacroStore::open_at(dir.path().to_path_buf());
        assert!(store.delete("../evil").is_err());
    }

    #[test]
    fn save_with_missing_second_image_leaves_no_assets_dir() {
        // Two WaitFor nodes; the SECOND one's source image is missing. The
        // existence pre-pass must fail before the first copy lands, so the
        // whole save is all-or-nothing.
        let dir = tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("targets/rec1")).unwrap();
        std::fs::write(dir.path().join("targets/rec1/t1.png"), b"png-bytes").unwrap();
        let store = MacroStore::open_at(dir.path().to_path_buf());
        let mut d = seg_doc("m4");
        d.nodes.push(wait_node("n2", "t1", "targets/rec1/t1.png"));
        d.nodes
            .push(wait_node("n3", "t2", "targets/rec1/missing.png"));
        d.edges.push(MacroEdge {
            from: "n1".into(),
            to: "n2".into(),
        });
        d.edges.push(MacroEdge {
            from: "n2".into(),
            to: "n3".into(),
        });
        let err = store.save(d).unwrap_err();
        assert!(err.contains("template image not found"), "{err}");
        assert!(!dir.path().join("macros/m4").exists());
        assert!(!dir.path().join("macros/m4.json").exists());
    }

    #[test]
    fn delete_removes_json_and_assets_dir() {
        let dir = tempdir().unwrap();
        let store = MacroStore::open_at(dir.path().to_path_buf());
        store.save(seg_doc("m3")).unwrap();
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
        store.save(seg_doc("keep")).unwrap();
        std::fs::create_dir_all(dir.path().join("macros/keep/assets")).unwrap();
        std::fs::create_dir_all(dir.path().join("macros/orphan/assets")).unwrap();
        store.sweep_orphans();
        assert!(dir.path().join("macros/keep").exists());
        assert!(!dir.path().join("macros/orphan").exists());
    }
}
