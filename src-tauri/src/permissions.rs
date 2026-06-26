//! Permission checks and macOS onboarding affordances.

use crate::observability;

#[cfg(target_os = "macos")]
use std::{path::PathBuf, sync::Mutex};

#[cfg(target_os = "macos")]
use core_foundation::{
    base::TCFType,
    boolean::CFBoolean,
    dictionary::{CFDictionary, CFDictionaryRef},
    string::{CFString, CFStringRef},
};
#[cfg(target_os = "macos")]
use objc2::{define_class, msg_send, rc::Retained, DefinedClass, MainThreadMarker, MainThreadOnly};
#[cfg(target_os = "macos")]
use objc2_app_kit::{NSEvent, NSView, NSWindow, NSWindowOrderingMode};
#[cfg(target_os = "macos")]
use objc2_foundation::{NSBundle, NSPoint, NSRect, NSSize, NSString};
#[cfg(target_os = "macos")]
use tauri::{Manager, WebviewWindow};

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

#[cfg(target_os = "macos")]
pub fn has_accessibility_permission() -> bool {
    unsafe { AXIsProcessTrusted() }
}

#[cfg(not(target_os = "macos"))]
pub fn has_accessibility_permission() -> bool {
    true
}

#[cfg(target_os = "macos")]
pub fn request_accessibility_permission() -> bool {
    let key = unsafe { CFString::wrap_under_get_rule(kAXTrustedCheckOptionPrompt) };
    let value = CFBoolean::true_value();
    let options = CFDictionary::from_CFType_pairs(&[(key, value)]);

    unsafe { AXIsProcessTrustedWithOptions(options.as_concrete_TypeRef()) }
}

#[cfg(not(target_os = "macos"))]
pub fn request_accessibility_permission() -> bool {
    true
}

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

#[tauri::command]
pub fn check_accessibility_permission(trace_id: Option<String>) -> Result<bool, String> {
    observability::trace_command("check_accessibility_permission", trace_id, None, || {
        Ok(has_accessibility_permission())
    })
}

#[tauri::command]
pub fn request_accessibility(trace_id: Option<String>) -> Result<bool, String> {
    observability::trace_command("request_accessibility", trace_id, None, || {
        Ok(request_accessibility_permission())
    })
}

#[cfg(target_os = "macos")]
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    static kAXTrustedCheckOptionPrompt: CFStringRef;

    fn AXIsProcessTrusted() -> bool;
    fn AXIsProcessTrustedWithOptions(options: CFDictionaryRef) -> bool;
}

#[cfg(target_os = "macos")]
#[derive(Default)]
pub struct PermissionDragState {
    view_ptr: Mutex<Option<usize>>,
}

#[cfg(target_os = "macos")]
struct PermissionDragViewIvars {
    app_path: Retained<NSString>,
}

#[cfg(target_os = "macos")]
define_class!(
    #[unsafe(super(NSView))]
    #[name = "MacroniPermissionDragView"]
    #[thread_kind = MainThreadOnly]
    #[ivars = PermissionDragViewIvars]
    struct PermissionDragView;

    impl PermissionDragView {
        #[unsafe(method(mouseDown:))]
        fn mouse_down(&self, event: &NSEvent) {
            let frame = self.bounds();
            #[allow(deprecated)]
            let _ = self.dragFile_fromRect_slideBack_event(
                &self.ivars().app_path,
                frame,
                true,
                event,
            );
        }

        #[unsafe(method(mouseDownCanMoveWindow))]
        fn mouse_down_can_move_window(&self) -> bool {
            false
        }
    }
);

#[cfg(target_os = "macos")]
impl PermissionDragView {
    fn new(mtm: MainThreadMarker, frame: NSRect, app_path: &str) -> Retained<Self> {
        let this = mtm.alloc().set_ivars(PermissionDragViewIvars {
            app_path: NSString::from_str(app_path),
        });

        unsafe { msg_send![super(this), initWithFrame: frame] }
    }
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub fn install_permission_drag_region(
    window: WebviewWindow,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    trace_id: Option<String>,
) -> Result<(), String> {
    observability::trace_command("install_permission_drag_region", trace_id, None, || {
        let app_path = app_bundle_path()?;
        let ns_window_ptr = window.ns_window().map_err(|e| e.to_string())? as usize;
        let app = window.app_handle().clone();
        let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();

        let run = window.run_on_main_thread(move || {
            let result = (|| -> Result<(), String> {
                let mtm = MainThreadMarker::new()
                    .ok_or_else(|| "run_on_main_thread closure not on main thread".to_string())?;
                let state = app.state::<PermissionDragState>();
                let mut view_ptr = state
                    .view_ptr
                    .lock()
                    .map_err(|_| "permission drag state mutex poisoned".to_string())?;

                create_or_reposition_drag_view(
                    mtm,
                    ns_window_ptr,
                    &mut view_ptr,
                    &app_path,
                    x,
                    y,
                    w,
                    h,
                )
            })();

            let _ = tx.send(result);
        });

        run.map_err(|e| format!("run_on_main_thread failed: {e}"))?;
        rx.recv()
            .map_err(|_| "main-thread closure dropped without result".to_string())?
    })
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn install_permission_drag_region(
    _window: tauri::WebviewWindow,
    _x: f64,
    _y: f64,
    _w: f64,
    _h: f64,
    _trace_id: Option<String>,
) -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub fn remove_permission_drag_region(
    window: WebviewWindow,
    trace_id: Option<String>,
) -> Result<(), String> {
    observability::trace_command("remove_permission_drag_region", trace_id, None, || {
        let app = window.app_handle().clone();
        let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();

        let run = window.run_on_main_thread(move || {
            let result = (|| -> Result<(), String> {
                MainThreadMarker::new()
                    .ok_or_else(|| "run_on_main_thread closure not on main thread".to_string())?;
                let state = app.state::<PermissionDragState>();
                let mut view_ptr = state
                    .view_ptr
                    .lock()
                    .map_err(|_| "permission drag state mutex poisoned".to_string())?;

                remove_drag_view(&mut view_ptr)
            })();

            let _ = tx.send(result);
        });

        run.map_err(|e| format!("run_on_main_thread failed: {e}"))?;
        rx.recv()
            .map_err(|_| "main-thread closure dropped without result".to_string())?
    })
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn remove_permission_drag_region(
    _window: tauri::WebviewWindow,
    _trace_id: Option<String>,
) -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "macos")]
fn create_or_reposition_drag_view(
    mtm: MainThreadMarker,
    ns_window_ptr: usize,
    view_ptr: &mut Option<usize>,
    app_path: &str,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    let frame = compute_frame(ns_window_ptr, x, y, w, h)?;

    if let Some(existing_ptr) = view_ptr {
        let view = unsafe {
            (*existing_ptr as *const PermissionDragView)
                .as_ref()
                .ok_or_else(|| "null permission drag view".to_string())?
        };
        view.setFrame(frame);
        return Ok(());
    }

    let ns_window = unsafe {
        (ns_window_ptr as *const NSWindow)
            .as_ref()
            .ok_or_else(|| "null NSWindow".to_string())?
    };
    let content_view = ns_window
        .contentView()
        .ok_or_else(|| "NSWindow has no contentView".to_string())?;

    let child = PermissionDragView::new(mtm, frame, app_path);
    let child_ptr = Retained::as_ptr(&child) as usize;
    content_view.addSubview_positioned_relativeTo(&child, NSWindowOrderingMode::Above, None);
    *view_ptr = Some(child_ptr);

    Ok(())
}

#[cfg(target_os = "macos")]
fn remove_drag_view(view_ptr: &mut Option<usize>) -> Result<(), String> {
    let Some(ptr) = view_ptr.take() else {
        return Ok(());
    };

    let view = unsafe {
        (ptr as *const PermissionDragView)
            .as_ref()
            .ok_or_else(|| "null permission drag view".to_string())?
    };
    view.removeFromSuperview();

    Ok(())
}

#[cfg(target_os = "macos")]
fn compute_frame(ns_window_ptr: usize, x: f64, y: f64, w: f64, h: f64) -> Result<NSRect, String> {
    let ns_window = unsafe {
        (ns_window_ptr as *const NSWindow)
            .as_ref()
            .ok_or_else(|| "null NSWindow".to_string())?
    };

    let scale = ns_window.backingScaleFactor();
    let scale = if scale <= 0.0 { 1.0 } else { scale };
    let layout = ns_window.contentLayoutRect();
    let x_pt = layout.origin.x + x / scale;
    let y_pt = y / scale;
    let w_pt = (w / scale).max(1.0);
    let h_pt = (h / scale).max(1.0);
    let webview_top = layout.origin.y + layout.size.height;
    let appkit_y = webview_top - (y_pt + h_pt);

    Ok(NSRect::new(
        NSPoint::new(x_pt, appkit_y),
        NSSize::new(w_pt, h_pt),
    ))
}

#[cfg(target_os = "macos")]
fn app_bundle_path() -> Result<String, String> {
    if let Some(path) = current_exe_app_bundle()? {
        return Ok(path.to_string_lossy().into_owned());
    }

    let bundle_path = NSBundle::mainBundle().bundlePath().to_string();
    if bundle_path.ends_with(".app") {
        return Ok(bundle_path);
    }

    Err("Macroni.app was not found. Build or launch the packaged app to drag it into System Settings.".to_string())
}

#[cfg(target_os = "macos")]
fn current_exe_app_bundle() -> Result<Option<PathBuf>, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;

    Ok(exe
        .ancestors()
        .find(|path| path.extension().is_some_and(|ext| ext == "app"))
        .map(PathBuf::from))
}
