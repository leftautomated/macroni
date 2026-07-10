//! Tauri command surface for the perception layer: run an extractor against a
//! live or recorded frame, and persist/retrieve targets + observations
//! through the recordings store.

use std::path::{Component, Path};

use serde::Deserialize;
use serde_json::json;
use tauri::{AppHandle, Manager};

use super::extractor::{crop_frame, ColorSampler, Extractor};
use super::source::{LiveSource, PerceptionSource, RecordingSource};
use super::template::TemplateMatcher;
use super::{png_io, Observation, ObservationResult, Region, Target, TargetKind};
use crate::observability;
use crate::recordings_store::{validate_storage_id, RecordingsStore};
use crate::types::Recording;

/// Where to pull the frame from for `extract_region`.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "PascalCase")]
pub enum ExtractSource {
    Live,
    Recording {
        recording_id: String,
        timestamp_ms: i64,
    },
}

/// Core seam: decode one frame from `source` and run `extractor` over it.
/// Testable without a Tauri `AppHandle`.
pub fn evaluate(
    source: &mut dyn PerceptionSource,
    timestamp_ms: i64,
    region: &Region,
    extractor: Box<dyn Extractor>,
) -> Result<ObservationResult, String> {
    let frame = source.frame_at(timestamp_ms)?;
    Ok(extractor.extract(&frame, region))
}

/// True iff `image` is safe to join onto a base directory: relative, and
/// carrying no component that could walk out of that base (`..`, a root, a
/// Windows drive prefix, or a literal `\` — which isn't a separator on
/// non-Windows targets, so `Component` parsing alone won't catch it there).
///
/// `image` is webview-supplied data (a macro/target's `TemplateMatch.image`)
/// that gets joined onto a base dir and read off disk — a path escape here
/// is a read-side exfil vector (e.g. `../../../../etc/passwd`).
pub(crate) fn is_safe_relative_path(image: &str) -> bool {
    let path = Path::new(image);
    path.is_relative()
        && !image.contains('\\')
        && path.components().all(|c| matches!(c, Component::Normal(_)))
}

/// Build the extractor implied by a target's `kind`, resolving any
/// `TemplateMatch` reference PNG relative to `base_dir`. Callers choose
/// `base_dir`: the app data dir for the on-demand command below, and the
/// macro's own directory for the live wait probe (`macros::probe`), so a
/// macro's template assets travel alongside its JSON. `TextOcr` uses the
/// macOS Vision extractor and is unavailable on other platforms.
pub(crate) fn build_extractor_with_base(
    kind: &TargetKind,
    base_dir: &Path,
) -> Result<Box<dyn Extractor>, String> {
    match kind {
        TargetKind::ColorSample { rgb, tolerance } => Ok(Box::new(ColorSampler {
            rgb: *rgb,
            tolerance: *tolerance,
        })),
        TargetKind::TemplateMatch {
            image,
            threshold,
            source_px,
        } => {
            if !is_safe_relative_path(image) {
                return Err("invalid template path".to_string());
            }
            let template = png_io::read_png(&base_dir.join(image))?;
            Ok(Box::new(TemplateMatcher {
                template,
                threshold: *threshold,
                source_px: *source_px,
            }))
        }
        TargetKind::TextOcr { .. } => {
            #[cfg(target_os = "macos")]
            {
                // On-demand extraction favors accuracy over speed.
                Ok(Box::new(super::extractor::VisionOcr { fast: false }))
            }
            #[cfg(not(target_os = "macos"))]
            {
                Err("ocr-unavailable-on-this-platform".to_string())
            }
        }
    }
}

/// Resolve a recording's absolute video path and fps. `VideoMetadata.path` is
/// stored relative to `<app_data>/videos/` (mirrors `useVideoAssetUrl` on the
/// frontend and `studio_export`'s resolution).
fn resolve_video(
    app: &AppHandle,
    recording: &Recording,
) -> Result<(std::path::PathBuf, u32), String> {
    let video = recording.video.as_ref().ok_or("recording has no video")?;
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok((data_dir.join("videos").join(&video.path), video.fps))
}

fn find_recording(store: &RecordingsStore, recording_id: &str) -> Result<Recording, String> {
    store
        .load_all()
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|r| r.id == recording_id)
        .ok_or_else(|| format!("recording '{}' not found", recording_id))
}

#[tauri::command]
pub fn extract_region(
    app: AppHandle,
    source: ExtractSource,
    region: Region,
    kind: TargetKind,
    trace_id: Option<String>,
) -> Result<ObservationResult, String> {
    let fields = match &source {
        ExtractSource::Live => json!({ "source": "live" }),
        ExtractSource::Recording {
            recording_id,
            timestamp_ms,
        } => json!({
            "source": "recording",
            "recordingId": recording_id,
            "timestampMs": timestamp_ms,
        }),
    };
    observability::trace_command("extract_region", trace_id, Some(fields), || {
        let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
        let extractor = build_extractor_with_base(&kind, &data_dir)?;
        let (mut source_impl, timestamp_ms): (Box<dyn PerceptionSource>, i64) = match &source {
            ExtractSource::Live => (Box::new(LiveSource::new()), 0),
            ExtractSource::Recording {
                recording_id,
                timestamp_ms,
            } => {
                let store = RecordingsStore::open(&app).map_err(|e| e.to_string())?;
                let recording = find_recording(&store, recording_id)?;
                let (path, fps) = resolve_video(&app, &recording)?;
                (Box::new(RecordingSource::open(&path, fps)?), *timestamp_ms)
            }
        };
        evaluate(source_impl.as_mut(), timestamp_ms, &region, extractor)
    })
}

#[tauri::command]
pub fn save_target(
    app: AppHandle,
    recording_id: String,
    mut target: Target,
    timestamp_ms: Option<i64>,
    trace_id: Option<String>,
) -> Result<Recording, String> {
    let fields = json!({ "recordingId": recording_id, "targetId": target.id });
    observability::trace_command("save_target", trace_id, Some(fields), || {
        // Both ids become path components below (template_path / add_target) —
        // reject any traversal attempt before a single path is built or a
        // single byte is written, not just once `add_target`'s own guard runs.
        validate_storage_id(&recording_id)?;
        validate_storage_id(&target.id)?;

        let store = RecordingsStore::open(&app).map_err(|e| e.to_string())?;

        if let TargetKind::TemplateMatch { threshold, .. } = target.kind {
            let timestamp_ms =
                timestamp_ms.ok_or("timestamp_ms is required for TemplateMatch targets")?;
            let region = target
                .region
                .ok_or("region is required for TemplateMatch targets")?;

            let recording = find_recording(&store, &recording_id)?;
            let (path, fps) = resolve_video(&app, &recording)?;
            let mut src = RecordingSource::open(&path, fps)?;
            let frame = src.frame_at(timestamp_ms)?;
            let cropped = crop_frame(&frame, &region);

            let template_path = store.template_path(&recording_id, &target.id);
            if let Some(parent) = template_path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            png_io::write_png(&template_path, &cropped)?;

            target.kind = TargetKind::TemplateMatch {
                image: format!("targets/{}/{}.png", recording_id, target.id),
                threshold,
                source_px: [frame.width, frame.height],
            };
        }

        store
            .add_target(&recording_id, target)
            .map_err(|e| e.to_string())
    })
}

#[tauri::command]
pub fn delete_target(
    app: AppHandle,
    recording_id: String,
    target_id: String,
    trace_id: Option<String>,
) -> Result<Recording, String> {
    let fields = json!({ "recordingId": recording_id, "targetId": target_id });
    observability::trace_command("delete_target", trace_id, Some(fields), || {
        RecordingsStore::open(&app)
            .map_err(|e| e.to_string())?
            .remove_target(&recording_id, &target_id)
            .map_err(|e| e.to_string())
    })
}

#[tauri::command]
pub fn load_observations(
    app: AppHandle,
    recording_id: String,
    trace_id: Option<String>,
) -> Result<Vec<Observation>, String> {
    let fields = json!({ "recordingId": recording_id });
    observability::trace_command("load_observations", trace_id, Some(fields), || {
        RecordingsStore::open(&app)
            .map_err(|e| e.to_string())?
            .load_observations(&recording_id)
            .map_err(|e| e.to_string())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::perception::{ObservationResult, Region, TargetKind};
    use render_core::frame::RgbaFrame;

    fn extractor_for_test(kind: &TargetKind) -> Box<dyn Extractor> {
        match kind {
            TargetKind::ColorSample { rgb, tolerance } => Box::new(ColorSampler {
                rgb: *rgb,
                tolerance: *tolerance,
            }),
            other => panic!("extractor_for_test: unsupported kind for this test: {other:?}"),
        }
    }

    // ---- build_extractor_with_base: template path validation -------------
    //
    // The `image` path inside a WaitFor target's TemplateMatch kind is
    // webview-supplied data. It is joined onto a base dir (data dir for the
    // command path; the macro's own dir for the live probe) to read a PNG
    // off disk, so any escape (absolute path, `..`, or a literal `\` that a
    // Windows-authored macro doc might smuggle in) must be rejected before
    // the join ever happens — a would-be read-side exfil vector.

    fn template_kind(image: &str) -> TargetKind {
        TargetKind::TemplateMatch {
            image: image.to_string(),
            threshold: 0.8,
            source_px: [10, 10],
        }
    }

    #[test]
    fn build_extractor_with_base_accepts_a_plain_relative_image_path() {
        let dir = tempfile::tempdir().unwrap();
        let template_path = dir.path().join("assets").join("t9.png");
        std::fs::create_dir_all(template_path.parent().unwrap()).unwrap();
        let frame = render_core::frame::RgbaFrame {
            width: 1,
            height: 1,
            data: vec![1, 2, 3, 255],
        };
        super::super::png_io::write_png(&template_path, &frame).unwrap();

        let result = build_extractor_with_base(&template_kind("assets/t9.png"), dir.path());
        assert!(result.is_ok(), "expected ok, got {:?}", result.err());
    }

    #[test]
    fn build_extractor_with_base_rejects_dot_dot_escape() {
        let dir = tempfile::tempdir().unwrap();
        let result = build_extractor_with_base(&template_kind("assets/../../x"), dir.path());
        assert_eq!(result.err(), Some("invalid template path".to_string()));
    }

    #[test]
    fn build_extractor_with_base_rejects_absolute_path() {
        let dir = tempfile::tempdir().unwrap();
        let result = build_extractor_with_base(&template_kind("/etc/passwd"), dir.path());
        assert_eq!(result.err(), Some("invalid template path".to_string()));
    }

    #[test]
    fn build_extractor_with_base_rejects_backslash_escape() {
        let dir = tempfile::tempdir().unwrap();
        let result = build_extractor_with_base(&template_kind("..\\x"), dir.path());
        assert_eq!(result.err(), Some("invalid template path".to_string()));
    }

    #[test]
    fn evaluate_runs_extractor_against_source_frame() {
        struct OneFrame(RgbaFrame);
        impl crate::perception::source::PerceptionSource for OneFrame {
            fn frame_at(&mut self, _ts: i64) -> Result<RgbaFrame, String> {
                Ok(self.0.clone())
            }
            fn dimensions(&self) -> (u32, u32) {
                (self.0.width, self.0.height)
            }
        }
        let frame = RgbaFrame {
            width: 2,
            height: 2,
            data: [9, 9, 9, 255].repeat(4),
        };
        let mut src = OneFrame(frame);
        let kind = TargetKind::ColorSample {
            rgb: [9, 9, 9],
            tolerance: 0.0,
        };
        let region = Region {
            x: 0.0,
            y: 0.0,
            w: 1.0,
            h: 1.0,
        };
        let result = evaluate(&mut src, 0, &region, extractor_for_test(&kind)).unwrap();
        assert!(matches!(
            result,
            ObservationResult::Color { matched: true, .. }
        ));
    }
}
