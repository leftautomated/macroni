//! Panic + startup logging to a file the user can share when something goes wrong.
//!
//! Writes to `<os-specific app data dir>/Macroni/crash.log`. Appended, not
//! truncated — if the app crashes repeatedly we keep the history. Resolves the
//! path via platform env vars instead of Tauri's path resolver so this module
//! can be installed BEFORE Tauri's setup runs (panics there would otherwise
//! have nowhere to go).

use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;

const APP_DIR_NAME: &str = "Macroni";
const LOG_FILE_NAME: &str = "crash.log";

/// Resolve the crash log path without touching Tauri. Returns `None` if no
/// reasonable location exists (extremely rare — indicates a broken env).
pub fn log_path() -> Option<PathBuf> {
    let base = app_data_base()?;
    Some(base.join(APP_DIR_NAME).join(LOG_FILE_NAME))
}

#[cfg(target_os = "windows")]
fn app_data_base() -> Option<PathBuf> {
    std::env::var_os("APPDATA").map(PathBuf::from)
}

#[cfg(target_os = "macos")]
fn app_data_base() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library").join("Application Support"))
}

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
fn app_data_base() -> Option<PathBuf> {
    std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local").join("share")))
}

/// Append a single line with an ISO-8601 timestamp. Silently ignores IO errors
/// — we must never panic from the logger itself (infinite loop in the panic
/// hook).
pub fn log_line(msg: &str) {
    let Some(path) = log_path() else { return };
    let Some(parent) = path.parent() else { return };
    let _ = std::fs::create_dir_all(parent);
    let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&path) else { return };
    let ts = chrono::Utc::now().to_rfc3339();
    let _ = writeln!(file, "[{ts}] {msg}");
}

/// Install a panic hook that appends the panic payload + location to crash.log,
/// then delegates to the default hook so stderr/debugger output still works.
/// Call once at the very top of `run()`.
pub fn install_panic_hook() {
    log_line("---- startup ----");
    log_line(&format!(
        "version={} os={} arch={}",
        env!("CARGO_PKG_VERSION"),
        std::env::consts::OS,
        std::env::consts::ARCH,
    ));

    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "<unknown>".to_string());
        let payload = if let Some(s) = info.payload().downcast_ref::<&str>() {
            (*s).to_string()
        } else if let Some(s) = info.payload().downcast_ref::<String>() {
            s.clone()
        } else {
            "<non-string panic payload>".to_string()
        };
        log_line(&format!("PANIC at {location}: {payload}"));
        default(info);
    }));
}
