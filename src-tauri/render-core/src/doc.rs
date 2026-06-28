//! ProjectDoc — serialisable single source of truth for the studio editor.
//! Pure data + serde; no GPU, no Tauri.

use serde::{Deserialize, Serialize};

// ── Rgba ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Rgba(pub [u8; 4]);

// ── Background ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
#[serde(rename_all_fields = "camelCase")]
pub enum Background {
    Solid {
        color: Rgba,
    },
    LinearGradient {
        from: Rgba,
        to: Rgba,
        angle_deg: f32,
    },
    Wallpaper {
        path: String,
    },
}

// ── Shadow ───────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Shadow {
    pub blur_px: f32,
    pub offset_y_px: f32,
    pub opacity: f32,
}

// ── Framing ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Framing {
    pub background: Background,
    pub padding_px: f32,
    pub border_radius_px: f32,
    pub shadow: Shadow,
}

// ── Inert region sub-types ───────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum ZoomSource {
    Auto,
    Manual,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ZoomRegion {
    pub id: String,
    pub start_ms: u64,
    pub end_ms: u64,
    pub scale: f32,
    pub focus_cx: f32,
    pub focus_cy: f32,
    pub source: ZoomSource,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrimRegion {
    pub id: String,
    pub start_ms: u64,
    pub end_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeedRegion {
    pub id: String,
    pub start_ms: u64,
    pub end_ms: u64,
    pub speed: f32,
}

// ── Media ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Media {
    pub screen_mp4: String,
    pub webcam_mp4: Option<String>,
    pub cursor_json: Option<String>,
}

// ── ProjectDoc ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDoc {
    pub version: u32,
    pub media: Media,
    pub framing: Framing,
    pub zoom_regions: Vec<ZoomRegion>,
    pub trim_regions: Vec<TrimRegion>,
    pub speed_regions: Vec<SpeedRegion>,
}

impl ProjectDoc {
    pub fn new_default(screen_mp4: String) -> Self {
        Self {
            version: 1,
            media: Media {
                screen_mp4,
                webcam_mp4: None,
                cursor_json: None,
            },
            framing: Framing {
                background: Background::Solid {
                    color: Rgba([30, 30, 30, 255]),
                },
                padding_px: 64.0,
                border_radius_px: 12.0,
                shadow: Shadow {
                    blur_px: 32.0,
                    offset_y_px: 16.0,
                    opacity: 0.35,
                },
            },
            zoom_regions: vec![],
            trim_regions: vec![],
            speed_regions: vec![],
        }
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn doc_round_trips_through_json() {
        let doc = ProjectDoc::new_default("rec1.mp4".into());
        let json = serde_json::to_string(&doc).unwrap();
        let back: ProjectDoc = serde_json::from_str(&json).unwrap();
        assert_eq!(doc, back);
        assert_eq!(back.version, 1);
        assert_eq!(back.media.screen_mp4, "rec1.mp4");
        // camelCase assertions
        assert!(
            json.contains("paddingPx"),
            "fields must serialize camelCase: {json}"
        );
        assert!(
            json.contains("screenMp4"),
            "fields must serialize camelCase: {json}"
        );
    }

    #[test]
    fn background_variants_round_trip() {
        for bg in [
            Background::Solid {
                color: Rgba([10, 20, 30, 255]),
            },
            Background::LinearGradient {
                from: Rgba([0, 0, 0, 255]),
                to: Rgba([255, 255, 255, 255]),
                angle_deg: 45.0,
            },
            Background::Wallpaper {
                path: "w.jpg".into(),
            },
        ] {
            let s = serde_json::to_string(&bg).unwrap();
            assert_eq!(bg, serde_json::from_str::<Background>(&s).unwrap());
        }
    }

    #[test]
    fn background_linear_gradient_fields_are_camel_case() {
        let bg = Background::LinearGradient {
            from: Rgba([0, 0, 0, 255]),
            to: Rgba([255, 255, 255, 255]),
            angle_deg: 90.0,
        };
        let s = serde_json::to_string(&bg).unwrap();
        assert!(
            s.contains("angleDeg"),
            "LinearGradient fields must be camelCase: {s}"
        );
    }
}
