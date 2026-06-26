//! Permission checks. Today we only need macOS Screen Recording (TCC
//! `kTCCServiceScreenCapture`). Windows needs no permission for WGC.

use crate::observability;

#[cfg(target_os = "macos")]
pub fn has_screen_recording_permission() -> bool {
    scap::has_permission()
}

#[cfg(not(target_os = "macos"))]
pub fn has_screen_recording_permission() -> bool {
    true
}

#[cfg(target_os = "macos")]
pub fn request_screen_recording_permission() {
    // scap::request_permission triggers the OS prompt. A user must then restart.
    // The returned bool indicates current permission state; we ignore it here
    // because the caller polls via has_screen_recording_permission.
    let _ = scap::request_permission();
}

#[cfg(not(target_os = "macos"))]
pub fn request_screen_recording_permission() {}

#[tauri::command]
pub fn check_screen_recording_permission(trace_id: Option<String>) -> Result<bool, String> {
    observability::trace_command("check_screen_recording_permission", trace_id, None, || {
        Ok(has_screen_recording_permission())
    })
}

#[tauri::command]
pub fn request_screen_recording(trace_id: Option<String>) -> Result<(), String> {
    observability::trace_command("request_screen_recording", trace_id, None, || {
        request_screen_recording_permission();
        Ok(())
    })
}
