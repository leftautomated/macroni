//! App observability helpers built on Tauri's official log plugin.
//!
//! The plugin owns durable log files, rotation, filtering, and the webview
//! bridge. This module only standardizes app-specific events, command timings,
//! and the diagnostics snapshot command.

use std::path::Path;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use log::Level;
use serde::Serialize;
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Manager};

use crate::crash_log;

const SLOW_COMMAND_MS: f64 = 250.0;
const RECENT_LOG_LINES: usize = 80;

/// Snapshot returned to the frontend when a user needs to share diagnostics.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsSnapshot {
    pub app_version: &'static str,
    pub os: &'static str,
    pub arch: &'static str,
    pub is_recording: bool,
    pub is_playing: bool,
    pub app_log_dir: Option<String>,
    pub crash_log_path: Option<String>,
    pub crash_log_bytes: Option<u64>,
    pub log_files: Vec<LogFileSummary>,
    pub recent_log_lines: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogFileSummary {
    pub path: String,
    pub bytes: u64,
    pub modified_ms: Option<u128>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticEvent<'a> {
    timestamp: String,
    level: &'a str,
    area: &'a str,
    name: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    trace_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    duration_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    fields: Option<Value>,
}

/// Emit startup context after the official log plugin has been attached.
pub fn init(app: &AppHandle) {
    let app_log_dir = app
        .path()
        .app_log_dir()
        .ok()
        .map(|path| path.to_string_lossy().into_owned());
    log_info(
        "app",
        "observability.initialized",
        Some(json!({
            "appLogDir": app_log_dir,
            "version": env!("CARGO_PKG_VERSION"),
            "os": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
        })),
    );
}

/// Time a Tauri command and write start/finish/error diagnostics.
pub fn trace_command<T, E, F>(
    command: &'static str,
    trace_id: Option<String>,
    fields: Option<Value>,
    run: F,
) -> Result<T, E>
where
    E: ToString,
    F: FnOnce() -> Result<T, E>,
{
    let trace = CommandTrace::start(command, trace_id, fields);
    let result = run();
    trace.finish(&result);
    result
}

pub fn log_info(area: &'static str, name: &'static str, fields: Option<Value>) {
    log_event(Level::Info, area, name, None, None, None, fields, None);
}

pub fn log_warn(area: &'static str, name: &'static str, message: &str, fields: Option<Value>) {
    log_event(
        Level::Warn,
        area,
        name,
        None,
        Some(message),
        None,
        fields,
        None,
    );
}

pub fn log_error(area: &'static str, name: &'static str, error: &str, fields: Option<Value>) {
    log_event(
        Level::Error,
        area,
        name,
        None,
        None,
        None,
        fields,
        Some(error),
    );
}

pub fn diagnostics_snapshot(
    app: &AppHandle,
    is_recording: bool,
    is_playing: bool,
) -> DiagnosticsSnapshot {
    let app_log_dir = app.path().app_log_dir().ok();
    let log_files = app_log_dir.as_deref().map(log_files).unwrap_or_default();
    let recent_log_lines = log_files
        .last()
        .map(|summary| recent_lines(Path::new(&summary.path), RECENT_LOG_LINES))
        .unwrap_or_default();
    let crash_log_path = crash_log::log_path();

    DiagnosticsSnapshot {
        app_version: env!("CARGO_PKG_VERSION"),
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        is_recording,
        is_playing,
        app_log_dir: app_log_dir.map(|p| p.to_string_lossy().into_owned()),
        crash_log_bytes: crash_log_path.as_deref().and_then(file_size),
        crash_log_path: crash_log_path.map(|p| p.to_string_lossy().into_owned()),
        log_files,
        recent_log_lines,
    }
}

fn log_event(
    level: Level,
    area: &str,
    name: &str,
    trace_id: Option<&str>,
    message: Option<&str>,
    duration_ms: Option<f64>,
    fields: Option<Value>,
    error: Option<&str>,
) {
    let event = DiagnosticEvent {
        timestamp: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        level: level.as_str(),
        area,
        name,
        trace_id,
        message,
        error,
        duration_ms,
        fields,
    };
    let serialized = serde_json::to_string(&event).unwrap_or_else(|e| {
        format!(
            "{{\"level\":\"ERROR\",\"area\":\"observability\",\"name\":\"serialize_failed\",\"error\":\"{}\"}}",
            e
        )
    });
    log::log!(target: "macroni::observability", level, "{serialized}");
}

struct CommandTrace {
    command: &'static str,
    trace_id: Option<String>,
    fields: Option<Value>,
    started_at: Instant,
}

impl CommandTrace {
    fn start(command: &'static str, trace_id: Option<String>, fields: Option<Value>) -> Self {
        log_event(
            Level::Debug,
            "tauri.command",
            "start",
            trace_id.as_deref(),
            None,
            None,
            Some(command_fields(command, fields.clone())),
            None,
        );

        Self {
            command,
            trace_id,
            fields,
            started_at: Instant::now(),
        }
    }

    fn finish<T, E: ToString>(&self, result: &Result<T, E>) {
        let duration_ms = self.started_at.elapsed().as_secs_f64() * 1000.0;
        match result {
            Ok(_) => {
                let (level, name) = if duration_ms >= SLOW_COMMAND_MS {
                    (Level::Warn, "slow")
                } else {
                    (Level::Info, "finish")
                };
                log_event(
                    level,
                    "tauri.command",
                    name,
                    self.trace_id.as_deref(),
                    None,
                    Some(duration_ms),
                    Some(command_fields(self.command, self.fields.clone())),
                    None,
                );
            }
            Err(error) => {
                let error = error.to_string();
                log_event(
                    Level::Error,
                    "tauri.command",
                    "error",
                    self.trace_id.as_deref(),
                    None,
                    Some(duration_ms),
                    Some(command_fields(self.command, self.fields.clone())),
                    Some(&error),
                );
            }
        }
    }
}

fn command_fields(command: &str, fields: Option<Value>) -> Value {
    let mut map = object_or_wrapped(fields, "fields");
    map.insert("command".to_string(), Value::String(command.to_string()));
    Value::Object(map)
}

fn object_or_wrapped(fields: Option<Value>, wrapper_key: &str) -> Map<String, Value> {
    match fields {
        Some(Value::Object(map)) => map,
        Some(value) => {
            let mut map = Map::new();
            map.insert(wrapper_key.to_string(), value);
            map
        }
        None => Map::new(),
    }
}

fn log_files(dir: &Path) -> Vec<LogFileSummary> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut files: Vec<LogFileSummary> = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let metadata = entry.metadata().ok()?;
            if !metadata.is_file() {
                return None;
            }
            Some(LogFileSummary {
                path: path.to_string_lossy().into_owned(),
                bytes: metadata.len(),
                modified_ms: metadata.modified().ok().and_then(system_time_ms),
            })
        })
        .collect();
    files.sort_by_key(|file| file.modified_ms.unwrap_or(0));
    files
}

fn system_time_ms(time: SystemTime) -> Option<u128> {
    time.duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_millis())
}

fn file_size(path: &Path) -> Option<u64> {
    std::fs::metadata(path).map(|m| m.len()).ok()
}

fn recent_lines(path: &Path, max_lines: usize) -> Vec<String> {
    let Ok(content) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let mut lines: Vec<String> = content
        .lines()
        .rev()
        .take(max_lines)
        .map(ToOwned::to_owned)
        .collect();
    lines.reverse();
    lines
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn command_fields_merges_extra_fields_with_command() {
        let fields = command_fields("load_recordings", Some(json!({ "count": 3 })));

        assert_eq!(fields["command"], "load_recordings");
        assert_eq!(fields["count"], 3);
    }

    #[test]
    fn command_fields_preserves_non_object_payload_under_fields() {
        let fields = command_fields("load_recordings", Some(json!("plain")));

        assert_eq!(fields["command"], "load_recordings");
        assert_eq!(fields["fields"], "plain");
    }

    #[test]
    fn recent_lines_returns_last_lines_in_original_order() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("events.log");
        std::fs::write(&path, "one\ntwo\nthree\nfour\n").unwrap();

        assert_eq!(recent_lines(&path, 2), vec!["three", "four"]);
    }
}
