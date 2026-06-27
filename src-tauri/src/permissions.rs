//! Permission checks and macOS onboarding affordances.

use crate::observability;

#[cfg(target_os = "macos")]
use std::{path::PathBuf, sync::Mutex};

#[cfg(target_os = "macos")]
use core_foundation::{
    base::{CFType, TCFType},
    boolean::CFBoolean,
    dictionary::{CFDictionary, CFDictionaryRef},
    number::CFNumber,
    string::{CFString, CFStringRef},
};
#[cfg(target_os = "macos")]
use core_graphics::window::{
    copy_window_info, kCGNullWindowID, kCGWindowBounds, kCGWindowLayer,
    kCGWindowListExcludeDesktopElements, kCGWindowListOptionOnScreenOnly, kCGWindowOwnerName,
};
#[cfg(target_os = "macos")]
use objc2::{
    define_class, msg_send, rc::Retained, ClassType, DefinedClass, MainThreadMarker, MainThreadOnly,
};
#[cfg(target_os = "macos")]
use objc2_app_kit::{
    NSAnimationContext, NSBackingStoreType, NSColor, NSEvent, NSFont, NSImageView, NSScreen,
    NSStatusWindowLevel, NSTextField, NSView, NSVisualEffectBlendingMode, NSVisualEffectMaterial,
    NSVisualEffectState, NSVisualEffectView, NSWindow, NSWindowCollectionBehavior,
    NSWindowOrderingMode, NSWindowStyleMask, NSWorkspace,
};
#[cfg(target_os = "macos")]
use objc2_foundation::{NSBundle, NSInteger, NSPoint, NSRect, NSSize, NSString};
#[cfg(target_os = "macos")]
use tauri::{AppHandle, Manager, WebviewWindow};
#[cfg(target_os = "macos")]
use tauri_nspanel::{ManagerExt, PanelLevel};

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
#[derive(Default)]
pub struct PermissionAssistantState {
    window_ptr: Mutex<Option<usize>>,
    last_frame: Mutex<Option<AssistantFrameSnapshot>>,
    window_flow: Mutex<PermissionWindowFlowState>,
}

#[derive(Clone, Copy, serde::Deserialize)]
pub struct PermissionAssistantSourceRect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[cfg(target_os = "macos")]
#[derive(Clone, Copy)]
struct AssistantFrameSnapshot {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[cfg(target_os = "macos")]
impl AssistantFrameSnapshot {
    fn from_rect(rect: NSRect) -> Self {
        Self {
            x: rect.origin.x,
            y: rect.origin.y,
            width: rect.size.width,
            height: rect.size.height,
        }
    }

    fn to_rect(self) -> NSRect {
        NSRect::new(
            NSPoint::new(self.x, self.y),
            NSSize::new(self.width, self.height),
        )
    }
}

#[cfg(target_os = "macos")]
#[derive(Default)]
struct PermissionWindowFlowState {
    lowered: bool,
}

#[cfg(target_os = "macos")]
#[derive(Clone, Copy)]
enum PermissionPanel {
    Accessibility,
    ScreenRecording,
}

#[cfg(target_os = "macos")]
impl PermissionPanel {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "accessibility" => Ok(Self::Accessibility),
            "screen-recording" => Ok(Self::ScreenRecording),
            _ => Err(format!("unknown permission assistant panel: {value}")),
        }
    }

    fn allowed_target(self) -> &'static str {
        match self {
            Self::Accessibility => "Accessibility",
            Self::ScreenRecording => "Screen Recording",
        }
    }
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
            let frame = NSRect::new(NSPoint::new(10.0, 8.5), NSSize::new(26.0, 26.0));
            self.setAlphaValue(0.0);
            #[allow(deprecated)]
            let _ = self.dragFile_fromRect_slideBack_event(
                &self.ivars().app_path,
                frame,
                true,
                event,
            );
            fade_drag_view_in(self.as_super());
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
fn fade_drag_view_in(view: &NSView) {
    const DURATION_SECONDS: f64 = 0.14;

    NSAnimationContext::beginGrouping();
    let context = NSAnimationContext::currentContext();
    context.setDuration(DURATION_SECONDS);
    context.setAllowsImplicitAnimation(true);

    let animator: Retained<NSView> = unsafe { msg_send![view, animator] };
    animator.setAlphaValue(1.0);

    NSAnimationContext::endGrouping();
}

#[cfg(target_os = "macos")]
fn fade_window_in(window: &NSWindow) {
    const DURATION_SECONDS: f64 = 0.16;

    NSAnimationContext::beginGrouping();
    let context = NSAnimationContext::currentContext();
    context.setDuration(DURATION_SECONDS);
    context.setAllowsImplicitAnimation(true);

    let animator: Retained<NSWindow> = unsafe { msg_send![window, animator] };
    animator.setAlphaValue(1.0);

    NSAnimationContext::endGrouping();
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
        let app_path = permission_drag_path()?;
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
#[tauri::command]
pub fn present_permission_assistant(
    window: WebviewWindow,
    panel: String,
    source_rect: Option<PermissionAssistantSourceRect>,
    trace_id: Option<String>,
) -> Result<bool, String> {
    observability::trace_command("present_permission_assistant", trace_id, None, || {
        let panel = PermissionPanel::parse(&panel)?;
        let app_path = permission_drag_path()?;
        let ns_window_ptr = window.ns_window().map_err(|e| e.to_string())? as usize;
        let app = window.app_handle().clone();
        let (tx, rx) = std::sync::mpsc::channel::<Result<bool, String>>();

        let run = window.run_on_main_thread(move || {
            let result = (|| -> Result<bool, String> {
                let mtm = MainThreadMarker::new()
                    .ok_or_else(|| "run_on_main_thread closure not on main thread".to_string())?;
                let state = app.state::<PermissionAssistantState>();
                let mut window_ptr = state
                    .window_ptr
                    .lock()
                    .map_err(|_| "permission assistant state mutex poisoned".to_string())?;

                let mut last_frame = state
                    .last_frame
                    .lock()
                    .map_err(|_| "permission assistant frame mutex poisoned".to_string())?;
                let mut window_flow = state
                    .window_flow
                    .lock()
                    .map_err(|_| "permission assistant flow mutex poisoned".to_string())?;

                lower_permission_flow_windows(&app, &mut window_flow)?;
                let Some((assistant, frame)) =
                    create_assistant_window(mtm, ns_window_ptr, &app_path, panel, source_rect)?
                else {
                    return Ok(false);
                };

                close_assistant_window(&mut window_ptr)?;
                *last_frame = Some(AssistantFrameSnapshot::from_rect(frame));
                *window_ptr = Some(Retained::into_raw(assistant) as usize);

                Ok(true)
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
pub fn present_permission_assistant(
    _window: tauri::WebviewWindow,
    _panel: String,
    _source_rect: Option<PermissionAssistantSourceRect>,
    _trace_id: Option<String>,
) -> Result<bool, String> {
    Ok(true)
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub fn refresh_permission_assistant(
    window: WebviewWindow,
    trace_id: Option<String>,
) -> Result<bool, String> {
    let _ = trace_id;
    let ns_window_ptr = window.ns_window().map_err(|e| e.to_string())? as usize;
    let app = window.app_handle().clone();
    let (tx, rx) = std::sync::mpsc::channel::<Result<bool, String>>();

    let run = window.run_on_main_thread(move || {
        let result = (|| -> Result<bool, String> {
            let mtm = MainThreadMarker::new()
                .ok_or_else(|| "run_on_main_thread closure not on main thread".to_string())?;
            let state = app.state::<PermissionAssistantState>();
            let mut window_ptr = state
                .window_ptr
                .lock()
                .map_err(|_| "permission assistant state mutex poisoned".to_string())?;
            let mut last_frame = state
                .last_frame
                .lock()
                .map_err(|_| "permission assistant frame mutex poisoned".to_string())?;

            let Some(ptr) = *window_ptr else {
                let mut window_flow = state
                    .window_flow
                    .lock()
                    .map_err(|_| "permission assistant flow mutex poisoned".to_string())?;
                restore_permission_flow_windows(&app, &mut window_flow)?;
                *last_frame = None;
                return Ok(false);
            };

            let Some(target_frame) = assistant_frame(mtm, ns_window_ptr)? else {
                close_assistant_window(&mut window_ptr)?;
                *last_frame = None;
                let mut window_flow = state
                    .window_flow
                    .lock()
                    .map_err(|_| "permission assistant flow mutex poisoned".to_string())?;
                restore_permission_flow_windows(&app, &mut window_flow)?;
                return Ok(false);
            };
            let frame = smoothed_assistant_frame(*last_frame, target_frame);
            *last_frame = Some(AssistantFrameSnapshot::from_rect(frame));

            let assistant = unsafe {
                (ptr as *const NSWindow)
                    .as_ref()
                    .ok_or_else(|| "null permission assistant window".to_string())?
            };
            assistant.setFrame_display(frame, false);

            Ok(true)
        })();

        let _ = tx.send(result);
    });

    run.map_err(|e| format!("run_on_main_thread failed: {e}"))?;
    rx.recv()
        .map_err(|_| "main-thread closure dropped without result".to_string())?
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn refresh_permission_assistant(
    _window: tauri::WebviewWindow,
    _trace_id: Option<String>,
) -> Result<bool, String> {
    Ok(false)
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub fn dismiss_permission_assistant(
    window: WebviewWindow,
    trace_id: Option<String>,
) -> Result<(), String> {
    observability::trace_command("dismiss_permission_assistant", trace_id, None, || {
        let app = window.app_handle().clone();
        let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();

        let run = window.run_on_main_thread(move || {
            let result = (|| -> Result<(), String> {
                MainThreadMarker::new()
                    .ok_or_else(|| "run_on_main_thread closure not on main thread".to_string())?;
                let state = app.state::<PermissionAssistantState>();
                let mut window_ptr = state
                    .window_ptr
                    .lock()
                    .map_err(|_| "permission assistant state mutex poisoned".to_string())?;
                let mut last_frame = state
                    .last_frame
                    .lock()
                    .map_err(|_| "permission assistant frame mutex poisoned".to_string())?;
                let mut window_flow = state
                    .window_flow
                    .lock()
                    .map_err(|_| "permission assistant flow mutex poisoned".to_string())?;

                let close_result = close_assistant_window(&mut window_ptr);
                *last_frame = None;
                let restore_result = restore_permission_flow_windows(&app, &mut window_flow);

                close_result.and(restore_result)
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
pub fn dismiss_permission_assistant(
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
fn create_assistant_window(
    mtm: MainThreadMarker,
    source_window_ptr: usize,
    app_path: &str,
    panel: PermissionPanel,
    source_rect: Option<PermissionAssistantSourceRect>,
) -> Result<Option<(Retained<NSWindow>, NSRect)>, String> {
    let Some(target_frame) = assistant_frame(mtm, source_window_ptr)? else {
        return Ok(None);
    };
    let frame = source_rect
        .and_then(|rect| {
            assistant_initial_frame_from_source(mtm, source_window_ptr, rect, target_frame).ok()
        })
        .unwrap_or(target_frame);
    let should_animate_from_source = !rects_nearly_equal(frame, target_frame);
    let window = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            mtm.alloc(),
            frame,
            NSWindowStyleMask::Borderless
                | NSWindowStyleMask::NonactivatingPanel
                | NSWindowStyleMask::UtilityWindow,
            NSBackingStoreType::Buffered,
            false,
        )
    };

    unsafe {
        window.setReleasedWhenClosed(false);
    }
    window.setOpaque(false);
    window.setBackgroundColor(Some(&NSColor::clearColor()));
    window.setHasShadow(true);
    window.setMovable(false);
    window.setMovableByWindowBackground(false);
    window.setCanHide(false);
    window.setIgnoresMouseEvents(false);
    if should_animate_from_source {
        window.setAlphaValue(0.0);
    }
    window.setLevel(NSStatusWindowLevel + 1);
    window.setCollectionBehavior(
        NSWindowCollectionBehavior::CanJoinAllSpaces
            | NSWindowCollectionBehavior::Transient
            | NSWindowCollectionBehavior::IgnoresCycle
            | NSWindowCollectionBehavior::FullScreenAuxiliary,
    );

    let content = build_assistant_content(mtm, app_path, panel)?;
    window.setContentView(Some(&content));
    window.orderFrontRegardless();
    if should_animate_from_source {
        fade_window_in(&window);
    }

    Ok(Some((window, frame)))
}

#[cfg(target_os = "macos")]
fn close_assistant_window(window_ptr: &mut Option<usize>) -> Result<(), String> {
    let Some(ptr) = window_ptr.take() else {
        return Ok(());
    };

    let Some(window) = (unsafe { Retained::from_raw(ptr as *mut NSWindow) }) else {
        return Err("null permission assistant window".to_string());
    };
    window.orderOut(None);
    window.close();

    Ok(())
}

#[cfg(target_os = "macos")]
fn lower_permission_flow_windows(
    app: &AppHandle,
    state: &mut PermissionWindowFlowState,
) -> Result<(), String> {
    if state.lowered {
        return Ok(());
    }

    if let Some(window) = app.get_webview_window("main") {
        window.set_always_on_top(false).map_err(|e| e.to_string())?;
    }
    if let Ok(panel) = app.get_webview_panel("main") {
        panel.set_floating_panel(false);
        panel.set_level(PanelLevel::Normal.value());
    }

    if let Some(window) = app.get_webview_window("studio") {
        window.set_always_on_top(false).map_err(|e| e.to_string())?;
    }

    state.lowered = true;

    Ok(())
}

#[cfg(target_os = "macos")]
fn restore_permission_flow_windows(
    app: &AppHandle,
    state: &mut PermissionWindowFlowState,
) -> Result<(), String> {
    if !state.lowered {
        return Ok(());
    }

    if let Some(window) = app.get_webview_window("main") {
        window.set_always_on_top(true).map_err(|e| e.to_string())?;
    }
    if let Ok(panel) = app.get_webview_panel("main") {
        panel.set_floating_panel(true);
        panel.set_level(PanelLevel::Floating.value());
    }

    *state = PermissionWindowFlowState::default();

    Ok(())
}

#[cfg(target_os = "macos")]
fn smoothed_assistant_frame(current: Option<AssistantFrameSnapshot>, target: NSRect) -> NSRect {
    const EASE: f64 = 0.42;
    const DEADZONE: f64 = 1.25;

    let Some(current) = current else {
        return target;
    };
    let target = AssistantFrameSnapshot::from_rect(target);

    let x = ease_axis(current.x, target.x, EASE, DEADZONE);
    let y = ease_axis(current.y, target.y, EASE, DEADZONE);
    let width = ease_axis(current.width, target.width, EASE, DEADZONE);
    let height = ease_axis(current.height, target.height, EASE, DEADZONE);

    AssistantFrameSnapshot {
        x,
        y,
        width,
        height,
    }
    .to_rect()
}

#[cfg(target_os = "macos")]
fn ease_axis(current: f64, target: f64, ease: f64, deadzone: f64) -> f64 {
    let delta = target - current;
    if delta.abs() <= deadzone {
        current
    } else {
        current + delta * ease
    }
}

#[cfg(target_os = "macos")]
fn assistant_initial_frame_from_source(
    mtm: MainThreadMarker,
    source_window_ptr: usize,
    source_rect: PermissionAssistantSourceRect,
    target_frame: NSRect,
) -> Result<NSRect, String> {
    let source_frame = webview_rect_to_screen_frame(source_window_ptr, source_rect)?;
    let frame = NSRect::new(
        NSPoint::new(
            source_frame.origin.x + (source_frame.size.width - target_frame.size.width) / 2.0,
            source_frame.origin.y + (source_frame.size.height - target_frame.size.height) / 2.0,
        ),
        target_frame.size,
    );

    Ok(clamp_frame_to_visible_screen(mtm, frame, source_frame))
}

#[cfg(target_os = "macos")]
fn webview_rect_to_screen_frame(
    ns_window_ptr: usize,
    rect: PermissionAssistantSourceRect,
) -> Result<NSRect, String> {
    let ns_window = unsafe {
        (ns_window_ptr as *const NSWindow)
            .as_ref()
            .ok_or_else(|| "null NSWindow".to_string())?
    };

    let scale = ns_window.backingScaleFactor();
    let scale = if scale <= 0.0 { 1.0 } else { scale };
    let layout = ns_window.contentLayoutRect();
    let window_frame = ns_window.frame();
    let x_pt = layout.origin.x + rect.x / scale;
    let y_pt = rect.y / scale;
    let w_pt = (rect.width / scale).max(1.0);
    let h_pt = (rect.height / scale).max(1.0);
    let webview_top = layout.origin.y + layout.size.height;
    let appkit_y = webview_top - (y_pt + h_pt);

    Ok(NSRect::new(
        NSPoint::new(
            window_frame.origin.x + x_pt,
            window_frame.origin.y + appkit_y,
        ),
        NSSize::new(w_pt, h_pt),
    ))
}

#[cfg(target_os = "macos")]
fn clamp_frame_to_visible_screen(
    mtm: MainThreadMarker,
    frame: NSRect,
    reference_frame: NSRect,
) -> NSRect {
    const MARGIN: f64 = 8.0;

    let Some(screen) =
        screen_for_frame(mtm, reference_frame).or_else(|| screen_for_frame(mtm, frame))
    else {
        return frame;
    };
    let visible = screen.visibleFrame();
    let min_x = visible.origin.x + MARGIN;
    let max_x = (visible.origin.x + visible.size.width - frame.size.width - MARGIN).max(min_x);
    let min_y = visible.origin.y + MARGIN;
    let max_y = (visible.origin.y + visible.size.height - frame.size.height - MARGIN).max(min_y);

    NSRect::new(
        NSPoint::new(
            frame.origin.x.clamp(min_x, max_x),
            frame.origin.y.clamp(min_y, max_y),
        ),
        frame.size,
    )
}

#[cfg(target_os = "macos")]
fn rects_nearly_equal(a: NSRect, b: NSRect) -> bool {
    const EPSILON: f64 = 0.5;

    (a.origin.x - b.origin.x).abs() < EPSILON
        && (a.origin.y - b.origin.y).abs() < EPSILON
        && (a.size.width - b.size.width).abs() < EPSILON
        && (a.size.height - b.size.height).abs() < EPSILON
}

#[cfg(target_os = "macos")]
fn assistant_frame(
    mtm: MainThreadMarker,
    source_window_ptr: usize,
) -> Result<Option<NSRect>, String> {
    const WIDTH: f64 = 530.0;
    const HEIGHT: f64 = 109.0;
    const MARGIN: f64 = 8.0;

    let source_window = unsafe {
        (source_window_ptr as *const NSWindow)
            .as_ref()
            .ok_or_else(|| "null NSWindow".to_string())?
    };
    let screen = source_window
        .screen()
        .or_else(|| NSScreen::mainScreen(mtm))
        .ok_or_else(|| "no screen available for permission assistant".to_string())?;
    let Some(settings_frame) = system_settings_window_frame(mtm) else {
        return Ok(None);
    };
    let visible = screen_for_frame(mtm, settings_frame)
        .unwrap_or(screen)
        .visibleFrame();

    let sidebar_width = 170.0;
    let content_min_x = settings_frame.origin.x + sidebar_width;
    let content_width = (settings_frame.size.width - sidebar_width).max(WIDTH);
    let preferred_x = content_min_x + ((content_width - WIDTH) / 2.0) - 8.0;
    let preferred_y = settings_frame.origin.y + 14.0;

    let min_x = visible.origin.x + MARGIN;
    let max_x = visible.origin.x + visible.size.width - WIDTH - MARGIN;
    let min_y = visible.origin.y + MARGIN;
    let max_y = visible.origin.y + visible.size.height - HEIGHT - MARGIN;
    let x = preferred_x.clamp(min_x, max_x);
    let y = preferred_y.clamp(min_y, max_y);

    Ok(Some(NSRect::new(
        NSPoint::new(x, y),
        NSSize::new(WIDTH, HEIGHT),
    )))
}

#[cfg(target_os = "macos")]
fn build_assistant_content(
    mtm: MainThreadMarker,
    app_path: &str,
    panel: PermissionPanel,
) -> Result<Retained<NSView>, String> {
    let content = NSView::initWithFrame(
        mtm.alloc(),
        NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(530.0, 109.0)),
    );

    let material = NSVisualEffectView::initWithFrame(
        mtm.alloc(),
        NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(530.0, 109.0)),
    );
    material.setMaterial(NSVisualEffectMaterial::Popover);
    material.setBlendingMode(NSVisualEffectBlendingMode::BehindWindow);
    material.setState(NSVisualEffectState::Active);
    material.setWantsLayer(true);
    style_view_layer(
        material.as_ref(),
        &NSColor::windowBackgroundColor().colorWithAlphaComponent(0.78),
        18.0,
        Some(&NSColor::separatorColor().colorWithAlphaComponent(0.18)),
        0.5,
    )?;
    content.addSubview(&material);

    add_label(
        &content,
        &format!(
            "Drag Macroni to the list above to allow {}",
            panel.allowed_target()
        ),
        NSRect::new(NSPoint::new(24.0, 66.0), NSSize::new(482.0, 24.0)),
        14.0,
        false,
        &NSColor::labelColor().colorWithAlphaComponent(0.82),
        1,
        mtm,
    );

    let row = build_assistant_drag_row(mtm, app_path)?;
    content.addSubview(&row);

    Ok(content)
}

#[cfg(target_os = "macos")]
fn build_assistant_drag_row(
    mtm: MainThreadMarker,
    app_path: &str,
) -> Result<Retained<PermissionDragView>, String> {
    let row = PermissionDragView::new(
        mtm,
        NSRect::new(NSPoint::new(24.0, 17.0), NSSize::new(482.0, 43.0)),
        app_path,
    );
    row.as_super().setWantsLayer(true);
    style_view_layer(
        row.as_super(),
        &NSColor::windowBackgroundColor().colorWithAlphaComponent(0.42),
        7.0,
        Some(&NSColor::separatorColor().colorWithAlphaComponent(0.28)),
        1.0,
    )?;

    let workspace = NSWorkspace::sharedWorkspace();
    let icon = workspace.iconForFile(&NSString::from_str(app_path));
    icon.setSize(NSSize::new(28.0, 28.0));
    let icon_view = NSImageView::imageViewWithImage(&icon, mtm);
    icon_view.setFrame(NSRect::new(NSPoint::new(9.0, 7.5), NSSize::new(28.0, 28.0)));
    row.as_super().addSubview(&icon_view);

    add_label(
        row.as_super(),
        "Macroni",
        NSRect::new(NSPoint::new(47.0, 10.0), NSSize::new(370.0, 22.0)),
        15.0,
        true,
        &NSColor::labelColor().colorWithAlphaComponent(0.82),
        1,
        mtm,
    );

    Ok(row)
}

#[cfg(target_os = "macos")]
fn add_label(
    parent: &NSView,
    text: &str,
    frame: NSRect,
    font_size: f64,
    bold: bool,
    color: &NSColor,
    lines: NSInteger,
    mtm: MainThreadMarker,
) {
    let label = NSTextField::labelWithString(&NSString::from_str(text), mtm);
    let font = if bold {
        NSFont::boldSystemFontOfSize(font_size)
    } else {
        NSFont::systemFontOfSize(font_size)
    };
    label.setFont(Some(&font));
    label.setTextColor(Some(color));
    label.setMaximumNumberOfLines(lines);
    label.setFrame(frame);
    parent.addSubview(&label);
}

#[cfg(target_os = "macos")]
fn style_view_layer(
    view: &NSView,
    background: &NSColor,
    radius: f64,
    border: Option<&NSColor>,
    border_width: f64,
) -> Result<(), String> {
    view.setWantsLayer(true);
    let layer = view
        .layer()
        .ok_or_else(|| "view did not create a layer".to_string())?;
    let background = background.CGColor();
    layer.setBackgroundColor(Some(&background));
    layer.setCornerRadius(radius);
    layer.setMasksToBounds(true);

    if let Some(border) = border {
        let border = border.CGColor();
        layer.setBorderColor(Some(&border));
        layer.setBorderWidth(border_width);
    }

    Ok(())
}

#[cfg(target_os = "macos")]
fn system_settings_window_frame(mtm: MainThreadMarker) -> Option<NSRect> {
    let windows = copy_window_info(
        kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
        kCGNullWindowID,
    )?;
    let owner_key = unsafe { CFString::wrap_under_get_rule(kCGWindowOwnerName) }.as_CFType();
    let layer_key = unsafe { CFString::wrap_under_get_rule(kCGWindowLayer) }.as_CFType();
    let bounds_key = unsafe { CFString::wrap_under_get_rule(kCGWindowBounds) }.as_CFType();

    windows
        .get_all_values()
        .into_iter()
        .filter_map(|value| {
            let info = unsafe {
                CFDictionary::<CFType, CFType>::wrap_under_get_rule(value as CFDictionaryRef)
            };
            let owner = info.find(&owner_key)?.downcast::<CFString>()?.to_string();
            if owner != "System Settings" && owner != "System Preferences" {
                return None;
            }

            let layer = info.find(&layer_key)?.downcast::<CFNumber>()?.to_i32()?;
            if layer != 0 {
                return None;
            }

            let bounds_value = info.find(&bounds_key)?;
            let bounds = unsafe {
                CFDictionary::<CFType, CFType>::wrap_under_get_rule(
                    bounds_value.as_CFTypeRef() as CFDictionaryRef
                )
            };
            let rect = rect_from_cg_window_bounds(mtm, &bounds)?;
            if rect.size.width < 320.0 || rect.size.height < 240.0 {
                return None;
            }

            Some(rect)
        })
        .max_by(|a, b| {
            let a_area = a.size.width * a.size.height;
            let b_area = b.size.width * b.size.height;
            a_area.total_cmp(&b_area)
        })
}

#[cfg(target_os = "macos")]
fn rect_from_cg_window_bounds(
    mtm: MainThreadMarker,
    bounds: &CFDictionary<CFType, CFType>,
) -> Option<NSRect> {
    let x = window_bound_value(bounds, "X")?;
    let y = window_bound_value(bounds, "Y")?;
    let width = window_bound_value(bounds, "Width")?;
    let height = window_bound_value(bounds, "Height")?;
    let cg_rect = NSRect::new(NSPoint::new(x, y), NSSize::new(width, height));
    let screen = screen_for_cg_rect(mtm, cg_rect)?;
    let screen_frame = screen.frame();
    let appkit_y = screen_frame.origin.y + screen_frame.size.height - y - height;

    Some(NSRect::new(
        NSPoint::new(screen_frame.origin.x + x, appkit_y),
        NSSize::new(width, height),
    ))
}

#[cfg(target_os = "macos")]
fn window_bound_value(bounds: &CFDictionary<CFType, CFType>, key: &'static str) -> Option<f64> {
    let key = CFString::from_static_string(key).as_CFType();
    let number = bounds.find(&key)?.downcast::<CFNumber>()?;
    number
        .to_f64()
        .or_else(|| number.to_i64().map(|value| value as f64))
}

#[cfg(target_os = "macos")]
fn screen_for_cg_rect(mtm: MainThreadMarker, cg_rect: NSRect) -> Option<Retained<NSScreen>> {
    let center = NSPoint::new(
        cg_rect.origin.x + cg_rect.size.width / 2.0,
        cg_rect.origin.y + cg_rect.size.height / 2.0,
    );
    let screens = NSScreen::screens(mtm);

    for index in 0..screens.count() {
        let screen = screens.objectAtIndex(index);
        let frame = screen.frame();
        if center.x >= frame.origin.x
            && center.x <= frame.origin.x + frame.size.width
            && center.y >= frame.origin.y
            && center.y <= frame.origin.y + frame.size.height
        {
            return Some(screen);
        }
    }

    NSScreen::mainScreen(mtm)
}

#[cfg(target_os = "macos")]
fn screen_for_frame(mtm: MainThreadMarker, frame: NSRect) -> Option<Retained<NSScreen>> {
    let center = NSPoint::new(
        frame.origin.x + frame.size.width / 2.0,
        frame.origin.y + frame.size.height / 2.0,
    );
    let screens = NSScreen::screens(mtm);

    for index in 0..screens.count() {
        let screen = screens.objectAtIndex(index);
        let screen_frame = screen.frame();
        if center.x >= screen_frame.origin.x
            && center.x <= screen_frame.origin.x + screen_frame.size.width
            && center.y >= screen_frame.origin.y
            && center.y <= screen_frame.origin.y + screen_frame.size.height
        {
            return Some(screen);
        }
    }

    None
}

#[cfg(target_os = "macos")]
fn permission_drag_path() -> Result<String, String> {
    if let Some(path) = current_exe_app_bundle()? {
        return Ok(path.to_string_lossy().into_owned());
    }

    let bundle_path = NSBundle::mainBundle().bundlePath().to_string();
    if bundle_path.ends_with(".app") {
        return Ok(bundle_path);
    }

    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    if exe.exists() {
        return Ok(exe.to_string_lossy().into_owned());
    }

    Err("Macroni could not determine a file to drag into System Settings.".to_string())
}

#[cfg(target_os = "macos")]
fn current_exe_app_bundle() -> Result<Option<PathBuf>, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;

    Ok(exe
        .ancestors()
        .find(|path| path.extension().is_some_and(|ext| ext == "app"))
        .map(PathBuf::from))
}
