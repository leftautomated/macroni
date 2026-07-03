//! Multi-modal perception layer: extract structured observations (text,
//! template matches, color samples) from screen frames. Spec:
//! docs/superpowers/specs/2026-06-28-perception-layer-design.md

pub mod convert;
pub mod extractor;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Modality {
    Visual,
    // Audio reserved for a later spec.
}

/// Resolution-independent box; all fields normalized [0,1], top-left origin.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Region {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "PascalCase")]
pub enum TargetKind {
    /// OCR the region; `expect` is an optional text to match (used by later conditionals).
    TextOcr { expect: Option<String> },
    /// `image` is a data-dir-relative PNG path; `source_px` the dimensions of
    /// the source frame it was cropped from (drives ratio scaling at eval time).
    TemplateMatch {
        image: String,
        threshold: f32,
        source_px: [u32; 2],
    },
    /// `tolerance` = max per-channel absolute diff on the 0–255 scale.
    ColorSample { rgb: [u8; 3], tolerance: f32 },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Target {
    pub id: String,
    pub name: String,
    pub modality: Modality,
    pub region: Option<Region>, // Some for visual; None reserved for audio
    pub kind: TargetKind,
    pub created_at: i64,
}

#[allow(dead_code)] // consumed by Task 2 (store) and Task 3 (extractors)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TextSpan {
    pub text: String,
    pub region: Region,
    pub confidence: f32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "PascalCase")]
pub enum ObservationResult {
    Text {
        spans: Vec<TextSpan>,
    },
    Template {
        matched: bool,
        location: Option<Region>,
        score: f32,
    },
    Color {
        rgb: [u8; 3],
        matched: bool,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Observation {
    /// None = ad-hoc / continuous full-frame.
    pub target_id: Option<String>,
    /// Video-relative ms (same origin as encoder PTS / input events).
    pub timestamp_ms: i64,
    pub result: ObservationResult,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn target_kind_serde_round_trips_with_house_tagging() {
        let kinds = vec![
            TargetKind::TextOcr {
                expect: Some("Submit".into()),
            },
            TargetKind::TemplateMatch {
                image: "targets/1/t1.png".into(),
                threshold: 0.8,
                source_px: [1920, 1080],
            },
            TargetKind::ColorSample {
                rgb: [10, 20, 30],
                tolerance: 12.0,
            },
        ];
        for kind in kinds {
            let json = serde_json::to_string(&kind).unwrap();
            assert!(json.contains("\"type\""), "tagged like InputEvent: {json}");
            let back: TargetKind = serde_json::from_str(&json).unwrap();
            assert_eq!(back, kind);
        }
    }

    #[test]
    fn observation_round_trips() {
        let obs = Observation {
            target_id: None,
            timestamp_ms: 1500,
            result: ObservationResult::Text {
                spans: vec![TextSpan {
                    text: "OK".into(),
                    region: Region {
                        x: 0.1,
                        y: 0.2,
                        w: 0.3,
                        h: 0.05,
                    },
                    confidence: 0.97,
                }],
            },
        };
        let back: Observation =
            serde_json::from_str(&serde_json::to_string(&obs).unwrap()).unwrap();
        assert_eq!(back, obs);
    }

    #[test]
    fn legacy_recording_json_without_targets_loads() {
        let json = r#"{"id":"1","name":"x","events":[],"created_at":1,"playback_speed":1.0}"#;
        let rec: crate::types::Recording = serde_json::from_str(json).unwrap();
        assert!(rec.targets.is_empty());
    }
}
