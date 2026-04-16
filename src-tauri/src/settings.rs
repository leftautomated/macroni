//! Persistence for user-configurable app settings (settings.json in app data dir).

use crate::types::AppSettings;
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
pub fn load_settings(app: AppHandle) -> AppSettings {
    load(&app)
}

#[tauri::command]
pub fn save_settings(app: AppHandle, settings: AppSettings) -> Result<(), String> {
    save(&app, &settings)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::CaptureQuality;

    #[test]
    fn default_settings_have_sensible_values() {
        let s = AppSettings::default();
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
        assert_eq!(s.capture.fps, 30);
    }
}
