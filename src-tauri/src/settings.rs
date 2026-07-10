//! Persistence for user-configurable app settings (settings.json in app data dir).

use crate::observability;
use crate::types::AppSettings;
use serde_json::json;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("settings.json"))
}

pub fn load(app: &AppHandle) -> AppSettings {
    let path = match settings_path(app) {
        Ok(p) => p,
        Err(_) => return AppSettings::default(),
    };
    if !path.exists() {
        return AppSettings::default();
    }
    match std::fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
        Err(_) => AppSettings::default(),
    }
}

pub fn save(app: &AppHandle, settings: &AppSettings) -> Result<(), String> {
    let path = settings_path(app)?;
    let content = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn load_settings(app: AppHandle, trace_id: Option<String>) -> Result<AppSettings, String> {
    observability::trace_command("load_settings", trace_id, None, || Ok(load(&app)))
}

#[tauri::command]
pub fn save_settings(
    app: AppHandle,
    settings: AppSettings,
    trace_id: Option<String>,
) -> Result<(), String> {
    let fields = json!({
        "video": settings.capture.video,
        "fps": settings.capture.fps,
        "quality": settings.capture.quality,
        "audio": settings.capture.audio,
        "continuousOcr": settings.perception.continuous_ocr,
    });
    observability::trace_command("save_settings", trace_id, Some(fields), || {
        save(&app, &settings)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::CaptureQuality;

    #[test]
    fn default_settings_have_sensible_values() {
        let s = AppSettings::default();
        assert!(s.capture.video);
        assert_eq!(s.capture.fps, 30);
        assert!(matches!(s.capture.quality, CaptureQuality::Med));
        assert!(s.capture.audio);
    }

    #[test]
    fn settings_round_trip_serde() {
        let s = AppSettings::default();
        let json = serde_json::to_string(&s).unwrap();
        let back: AppSettings = serde_json::from_str(&json).unwrap();
        assert_eq!(back.capture.fps, s.capture.fps);
    }

    #[test]
    fn missing_fields_deserialize_to_defaults() {
        let json = "{}";
        let s: AppSettings = serde_json::from_str(json).unwrap();
        assert!(s.capture.video);
        assert_eq!(s.capture.fps, 30);
    }

    #[test]
    fn missing_capture_fields_deserialize_to_defaults() {
        let s: AppSettings = serde_json::from_str(r#"{"capture":{"fps":15}}"#).unwrap();
        assert!(s.capture.video);
        assert_eq!(s.capture.fps, 15);
        assert!(matches!(s.capture.quality, CaptureQuality::Med));
        assert!(s.capture.audio);
    }

    #[test]
    fn perception_defaults_off_and_missing_field_deserializes_off() {
        assert!(!AppSettings::default().perception.continuous_ocr);
        let s: AppSettings = serde_json::from_str("{}").unwrap();
        assert!(!s.perception.continuous_ocr);
        let s: AppSettings =
            serde_json::from_str(r#"{"perception":{"continuous_ocr":true}}"#).unwrap();
        assert!(s.perception.continuous_ocr);
    }
}
