//! Permission checks and macOS onboarding affordances.

use crate::observability;

#[cfg(target_os = "macos")]
use std::{
    path::PathBuf,
    sync::Mutex,
    time::{Duration, Instant},
};

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
    define_class, msg_send, rc::Retained, AnyThread, ClassType, DefinedClass, MainThreadMarker,
    MainThreadOnly,
};
#[cfg(target_os = "macos")]
use objc2_app_kit::{
    NSAnimationContext, NSAutoresizingMaskOptions, NSBackingStoreType, NSColor, NSEvent, NSFont,
    NSImage, NSImageScaling, NSImageView, NSScreen, NSStatusWindowLevel, NSTextAlignment,
    NSTextField, NSView, NSVisualEffectBlendingMode, NSVisualEffectMaterial, NSVisualEffectState,
    NSVisualEffectView, NSWindow, NSWindowCollectionBehavior, NSWindowOrderingMode,
    NSWindowStyleMask, NSWorkspace,
};
#[cfg(target_os = "macos")]
use objc2_foundation::{
    NSBundle, NSData, NSDataBase64DecodingOptions, NSInteger, NSPoint, NSRect, NSSize, NSString,
};
#[cfg(target_os = "macos")]
use objc2_quartz_core::{kCAMediaTimingFunctionEaseInEaseOut, CAMediaTimingFunction};
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
    active_panel: Mutex<Option<PermissionPanel>>,
    active_source_frame: Mutex<Option<AssistantFrameSnapshot>>,
    payload_ptr: Mutex<Option<usize>>,
    landing_payload_ptr: Mutex<Option<usize>>,
    last_frame: Mutex<Option<AssistantFrameSnapshot>>,
    opening_until: Mutex<Option<Instant>>,
    returning_until: Mutex<Option<Instant>>,
    completion_until: Mutex<Option<Instant>>,
    returning_reason: Mutex<Option<AssistantReturnReason>>,
    target_candidate: Mutex<Option<AssistantFrameCandidate>>,
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
struct AssistantFrameCandidate {
    frame: AssistantFrameSnapshot,
    since: Instant,
}

#[cfg(target_os = "macos")]
#[derive(Clone, Copy, PartialEq, Eq)]
enum AssistantReturnReason {
    SwitchPanel,
    Completed,
}

#[cfg(target_os = "macos")]
struct AssistantContentViews {
    root: Retained<NSView>,
    payload: Retained<NSView>,
    landing_payload: Retained<NSView>,
}

#[cfg(target_os = "macos")]
type CreatedAssistantWindow = (
    Retained<NSWindow>,
    NSRect,
    Option<NSRect>,
    usize,
    usize,
    bool,
);

#[cfg(target_os = "macos")]
type ReusedAssistantWindow = (usize, NSRect, Option<NSRect>, usize, usize, bool);

#[cfg(target_os = "macos")]
const ASSISTANT_OPEN_ANIMATION_MILLIS: u64 = 460;
#[cfg(target_os = "macos")]
const ASSISTANT_OPEN_ANIMATION_SECONDS: f64 = ASSISTANT_OPEN_ANIMATION_MILLIS as f64 / 1000.0;
#[cfg(target_os = "macos")]
const ASSISTANT_RETURN_ANIMATION_MILLIS: u64 = 260;
#[cfg(target_os = "macos")]
const ASSISTANT_RETURN_ANIMATION_SECONDS: f64 = ASSISTANT_RETURN_ANIMATION_MILLIS as f64 / 1000.0;
#[cfg(target_os = "macos")]
const ASSISTANT_CONTENT_FADE_SECONDS: f64 = 0.18;
#[cfg(target_os = "macos")]
const ASSISTANT_TARGET_SETTLE_MILLIS: u64 = 140;
#[cfg(target_os = "macos")]
const ASSISTANT_READY_POLL_MILLIS: u64 = 50;
#[cfg(target_os = "macos")]
const ASSISTANT_READY_TIMEOUT_MILLIS: u64 = 30_000;
#[cfg(target_os = "macos")]
const ASSISTANT_COMPLETION_HOLD_MILLIS: u64 = 650;

#[cfg(target_os = "macos")]
#[derive(Default)]
struct PermissionWindowFlowState {
    lowered: bool,
}

#[cfg(target_os = "macos")]
#[derive(Clone, Copy, PartialEq, Eq)]
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

    fn gate_description(self) -> &'static str {
        match self {
            Self::Accessibility => "Captures keyboard and mouse input.",
            Self::ScreenRecording => "Captures screen video for recordings.",
        }
    }

    fn gate_symbol_name(self) -> &'static str {
        match self {
            Self::Accessibility => "accessibility",
            Self::ScreenRecording => "camera",
        }
    }

    fn gate_symbol_fallback_name(self) -> &'static str {
        match self {
            Self::Accessibility => "figure.arms.open",
            Self::ScreenRecording => "record.circle",
        }
    }

    fn granted(self) -> bool {
        match self {
            Self::Accessibility => has_accessibility_permission(),
            Self::ScreenRecording => has_screen_recording_permission(),
        }
    }

    fn completion_title(self) -> &'static str {
        match self {
            Self::Accessibility => "Accessibility allowed",
            Self::ScreenRecording => "Screen Recording allowed",
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
fn animate_view_alpha(view: &NSView, alpha: f64, duration: f64) {
    NSAnimationContext::beginGrouping();
    let context = NSAnimationContext::currentContext();
    context.setDuration(duration);
    context.setAllowsImplicitAnimation(true);
    let timing =
        CAMediaTimingFunction::functionWithName(unsafe { kCAMediaTimingFunctionEaseInEaseOut });
    context.setTimingFunction(Some(&timing));

    let animator: Retained<NSView> = unsafe { msg_send![view, animator] };
    animator.setAlphaValue(alpha);

    NSAnimationContext::endGrouping();
}

#[cfg(target_os = "macos")]
fn animate_window_to_target(window: &NSWindow, target_frame: NSRect) {
    NSAnimationContext::beginGrouping();
    let context = NSAnimationContext::currentContext();
    context.setDuration(ASSISTANT_OPEN_ANIMATION_SECONDS);
    context.setAllowsImplicitAnimation(true);
    let timing =
        CAMediaTimingFunction::functionWithName(unsafe { kCAMediaTimingFunctionEaseInEaseOut });
    context.setTimingFunction(Some(&timing));

    let animator: Retained<NSWindow> = unsafe { msg_send![window, animator] };
    animator.setFrame_display(target_frame, true);
    animator.setAlphaValue(1.0);

    NSAnimationContext::endGrouping();
}

#[cfg(target_os = "macos")]
fn animate_window_back_to_source(
    window: &NSWindow,
    source_frame: NSRect,
    payload_ptr: Option<usize>,
    landing_payload_ptr: Option<usize>,
) {
    if let Some(landing_payload) =
        landing_payload_ptr.and_then(|ptr| unsafe { (ptr as *const NSView).as_ref() })
    {
        animate_view_alpha(landing_payload, 1.0, ASSISTANT_CONTENT_FADE_SECONDS);
    }

    if let Some(payload) = payload_ptr.and_then(|ptr| unsafe { (ptr as *const NSView).as_ref() }) {
        animate_view_alpha(payload, 0.0, ASSISTANT_CONTENT_FADE_SECONDS);
    }

    NSAnimationContext::beginGrouping();
    let context = NSAnimationContext::currentContext();
    context.setDuration(ASSISTANT_RETURN_ANIMATION_SECONDS);
    context.setAllowsImplicitAnimation(true);
    let timing =
        CAMediaTimingFunction::functionWithName(unsafe { kCAMediaTimingFunctionEaseInEaseOut });
    context.setTimingFunction(Some(&timing));

    let animator: Retained<NSWindow> = unsafe { msg_send![window, animator] };
    animator.setFrame_display(source_frame, true);

    NSAnimationContext::endGrouping();
}

#[cfg(target_os = "macos")]
fn animate_completed_window_back_to_source(window: &NSWindow, source_frame: NSRect) {
    NSAnimationContext::beginGrouping();
    let context = NSAnimationContext::currentContext();
    context.setDuration(ASSISTANT_RETURN_ANIMATION_SECONDS);
    context.setAllowsImplicitAnimation(true);
    let timing =
        CAMediaTimingFunction::functionWithName(unsafe { kCAMediaTimingFunctionEaseInEaseOut });
    context.setTimingFunction(Some(&timing));

    let animator: Retained<NSWindow> = unsafe { msg_send![window, animator] };
    animator.setFrame_display(source_frame, true);
    animator.setAlphaValue(0.0);

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
    source_image_data_url: Option<String>,
    trace_id: Option<String>,
) -> Result<bool, String> {
    observability::trace_command("present_permission_assistant", trace_id, None, || {
        let panel = PermissionPanel::parse(&panel)?;
        present_permission_assistant_once(
            &window,
            panel,
            source_rect,
            source_image_data_url.as_deref(),
        )
    })
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn present_permission_assistant_when_ready(
    window: WebviewWindow,
    panel: String,
    source_rect: Option<PermissionAssistantSourceRect>,
    source_image_data_url: Option<String>,
    trace_id: Option<String>,
) -> Result<bool, String> {
    let result = tauri::async_runtime::spawn_blocking(move || {
        observability::trace_command(
            "present_permission_assistant_when_ready",
            trace_id,
            None,
            || {
                let panel = PermissionPanel::parse(&panel)?;
                wait_for_permission_assistant(
                    &window,
                    panel,
                    source_rect,
                    source_image_data_url.as_deref(),
                )
            },
        )
    })
    .await
    .map_err(|e| e.to_string())?;

    result
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn present_permission_assistant(
    _window: tauri::WebviewWindow,
    _panel: String,
    _source_rect: Option<PermissionAssistantSourceRect>,
    _source_image_data_url: Option<String>,
    _trace_id: Option<String>,
) -> Result<bool, String> {
    Ok(true)
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub async fn present_permission_assistant_when_ready(
    _window: tauri::WebviewWindow,
    _panel: String,
    _source_rect: Option<PermissionAssistantSourceRect>,
    _source_image_data_url: Option<String>,
    _trace_id: Option<String>,
) -> Result<bool, String> {
    Ok(true)
}

#[cfg(target_os = "macos")]
fn wait_for_permission_assistant(
    window: &WebviewWindow,
    panel: PermissionPanel,
    source_rect: Option<PermissionAssistantSourceRect>,
    source_image_data_url: Option<&str>,
) -> Result<bool, String> {
    let deadline = Instant::now() + Duration::from_millis(ASSISTANT_READY_TIMEOUT_MILLIS);

    loop {
        if present_permission_assistant_once(window, panel, source_rect, source_image_data_url)? {
            return Ok(true);
        }

        if Instant::now() >= deadline {
            return Ok(false);
        }

        std::thread::sleep(Duration::from_millis(ASSISTANT_READY_POLL_MILLIS));
    }
}

#[cfg(target_os = "macos")]
fn present_permission_assistant_once(
    window: &WebviewWindow,
    panel: PermissionPanel,
    source_rect: Option<PermissionAssistantSourceRect>,
    source_image_data_url: Option<&str>,
) -> Result<bool, String> {
    let app_path = permission_drag_path()?;
    let ns_window_ptr = window.ns_window().map_err(|e| e.to_string())? as usize;
    let app = window.app_handle().clone();
    let source_image_data_url = source_image_data_url.map(str::to_owned);
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
            let mut active_panel = state
                .active_panel
                .lock()
                .map_err(|_| "permission assistant panel mutex poisoned".to_string())?;
            let mut active_source_frame = state
                .active_source_frame
                .lock()
                .map_err(|_| "permission assistant source mutex poisoned".to_string())?;
            let mut payload_ptr = state
                .payload_ptr
                .lock()
                .map_err(|_| "permission assistant payload mutex poisoned".to_string())?;
            let mut landing_payload_ptr = state
                .landing_payload_ptr
                .lock()
                .map_err(|_| "permission assistant landing payload mutex poisoned".to_string())?;

            let mut last_frame = state
                .last_frame
                .lock()
                .map_err(|_| "permission assistant frame mutex poisoned".to_string())?;
            let mut opening_until = state
                .opening_until
                .lock()
                .map_err(|_| "permission assistant animation mutex poisoned".to_string())?;
            let mut returning_until = state
                .returning_until
                .lock()
                .map_err(|_| "permission assistant return mutex poisoned".to_string())?;
            let mut completion_until = state
                .completion_until
                .lock()
                .map_err(|_| "permission assistant completion mutex poisoned".to_string())?;
            let mut returning_reason = state
                .returning_reason
                .lock()
                .map_err(|_| "permission assistant return reason mutex poisoned".to_string())?;
            let mut target_candidate = state
                .target_candidate
                .lock()
                .map_err(|_| "permission assistant target mutex poisoned".to_string())?;
            let mut window_flow = state
                .window_flow
                .lock()
                .map_err(|_| "permission assistant flow mutex poisoned".to_string())?;

            lower_permission_flow_windows(&app, &mut window_flow)?;

            if let Some(deadline) = returning_until.as_ref().copied() {
                if Instant::now() < deadline {
                    return Ok(false);
                }
                *active_panel = None;
                *active_source_frame = None;
                *payload_ptr = None;
                *landing_payload_ptr = None;
                *last_frame = (*window_ptr)
                    .and_then(|ptr| unsafe { (ptr as *const NSWindow).as_ref() })
                    .map(|window| AssistantFrameSnapshot::from_rect(window.frame()));
                *opening_until = None;
                *returning_until = None;
                *completion_until = None;
                *returning_reason = None;
                *target_candidate = None;
            }

            if completion_until.is_some() {
                return Ok(false);
            }

            let is_switching_panels = matches!(
                (*active_panel, source_rect),
                (Some(active), Some(_)) if active != panel
            );
            if is_switching_panels {
                let Some(ptr) = *window_ptr else {
                    *active_panel = None;
                    *active_source_frame = None;
                    *payload_ptr = None;
                    *landing_payload_ptr = None;
                    *opening_until = None;
                    *completion_until = None;
                    *returning_reason = None;
                    *target_candidate = None;
                    return Ok(false);
                };
                let assistant = unsafe {
                    (ptr as *const NSWindow)
                        .as_ref()
                        .ok_or_else(|| "null permission assistant window".to_string())?
                };
                let fallback_return_frame = webview_rect_to_screen_frame(
                    ns_window_ptr,
                    source_rect.ok_or_else(|| {
                        "missing source rect for permission assistant switch".to_string()
                    })?,
                )?;
                let return_frame = active_source_frame
                    .as_ref()
                    .copied()
                    .map(AssistantFrameSnapshot::to_rect)
                    .unwrap_or(fallback_return_frame);
                animate_window_back_to_source(
                    assistant,
                    return_frame,
                    *payload_ptr,
                    *landing_payload_ptr,
                );
                *opening_until = None;
                *returning_until =
                    Some(Instant::now() + Duration::from_millis(ASSISTANT_RETURN_ANIMATION_MILLIS));
                *completion_until = None;
                *returning_reason = Some(AssistantReturnReason::SwitchPanel);
                *target_candidate = None;
                return Ok(false);
            }

            let Some(target_frame) =
                settled_assistant_frame(mtm, ns_window_ptr, &mut target_candidate)?
            else {
                return Ok(false);
            };
            let (
                assistant,
                frame,
                source_frame,
                next_payload_ptr,
                next_landing_payload_ptr,
                is_opening,
            ) = if active_panel.is_none() && window_ptr.is_some() {
                reuse_assistant_window(
                    mtm,
                    *window_ptr,
                    ns_window_ptr,
                    &app_path,
                    panel,
                    target_frame,
                    source_rect,
                    source_image_data_url.as_deref(),
                )?
            } else {
                close_assistant_window(&mut window_ptr)?;
                *payload_ptr = None;
                *landing_payload_ptr = None;
                let (
                    assistant,
                    frame,
                    source_frame,
                    next_payload_ptr,
                    next_landing_payload_ptr,
                    is_opening,
                ) = create_assistant_window(
                    mtm,
                    ns_window_ptr,
                    &app_path,
                    panel,
                    target_frame,
                    source_rect,
                    source_image_data_url.as_deref(),
                )?;
                (
                    Retained::into_raw(assistant) as usize,
                    frame,
                    source_frame,
                    next_payload_ptr,
                    next_landing_payload_ptr,
                    is_opening,
                )
            };

            *last_frame = Some(AssistantFrameSnapshot::from_rect(frame));
            *opening_until = if is_opening {
                Some(Instant::now() + Duration::from_millis(ASSISTANT_OPEN_ANIMATION_MILLIS))
            } else {
                None
            };
            *target_candidate = None;
            *active_panel = Some(panel);
            *active_source_frame = source_frame.map(AssistantFrameSnapshot::from_rect);
            *payload_ptr = Some(next_payload_ptr);
            *landing_payload_ptr = Some(next_landing_payload_ptr);
            *window_ptr = Some(assistant);
            *completion_until = None;
            *returning_reason = None;

            Ok(true)
        })();

        let _ = tx.send(result);
    });

    run.map_err(|e| format!("run_on_main_thread failed: {e}"))?;
    rx.recv()
        .map_err(|_| "main-thread closure dropped without result".to_string())?
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
            let mut active_panel = state
                .active_panel
                .lock()
                .map_err(|_| "permission assistant panel mutex poisoned".to_string())?;
            let mut active_source_frame = state
                .active_source_frame
                .lock()
                .map_err(|_| "permission assistant source mutex poisoned".to_string())?;
            let mut payload_ptr = state
                .payload_ptr
                .lock()
                .map_err(|_| "permission assistant payload mutex poisoned".to_string())?;
            let mut landing_payload_ptr = state
                .landing_payload_ptr
                .lock()
                .map_err(|_| "permission assistant landing payload mutex poisoned".to_string())?;
            let mut last_frame = state
                .last_frame
                .lock()
                .map_err(|_| "permission assistant frame mutex poisoned".to_string())?;
            let mut opening_until = state
                .opening_until
                .lock()
                .map_err(|_| "permission assistant animation mutex poisoned".to_string())?;
            let mut returning_until = state
                .returning_until
                .lock()
                .map_err(|_| "permission assistant return mutex poisoned".to_string())?;
            let mut completion_until = state
                .completion_until
                .lock()
                .map_err(|_| "permission assistant completion mutex poisoned".to_string())?;
            let mut returning_reason = state
                .returning_reason
                .lock()
                .map_err(|_| "permission assistant return reason mutex poisoned".to_string())?;

            let Some(ptr) = *window_ptr else {
                let mut window_flow = state
                    .window_flow
                    .lock()
                    .map_err(|_| "permission assistant flow mutex poisoned".to_string())?;
                restore_permission_flow_windows(&app, &mut window_flow)?;
                *active_panel = None;
                *active_source_frame = None;
                *payload_ptr = None;
                *landing_payload_ptr = None;
                *last_frame = None;
                *opening_until = None;
                *returning_until = None;
                *completion_until = None;
                *returning_reason = None;
                return Ok(false);
            };

            if let Some(deadline) = returning_until.as_ref().copied() {
                if Instant::now() < deadline {
                    return Ok(true);
                }
                if *returning_reason == Some(AssistantReturnReason::Completed) {
                    let close_result = close_assistant_window(&mut window_ptr);
                    clear_assistant_runtime_state(
                        &mut active_panel,
                        &mut active_source_frame,
                        &mut payload_ptr,
                        &mut landing_payload_ptr,
                        &mut last_frame,
                        &mut opening_until,
                        &mut returning_until,
                        &mut completion_until,
                        &mut returning_reason,
                    );
                    let mut window_flow = state
                        .window_flow
                        .lock()
                        .map_err(|_| "permission assistant flow mutex poisoned".to_string())?;
                    let restore_result = restore_permission_flow_windows(&app, &mut window_flow);
                    return close_result.and(restore_result).map(|()| false);
                } else {
                    *active_panel = None;
                    *active_source_frame = None;
                    *payload_ptr = None;
                    *landing_payload_ptr = None;
                    *last_frame = (*window_ptr)
                        .and_then(|ptr| unsafe { (ptr as *const NSWindow).as_ref() })
                        .map(|window| AssistantFrameSnapshot::from_rect(window.frame()));
                    *opening_until = None;
                    *returning_until = None;
                    *completion_until = None;
                    *returning_reason = None;
                    return Ok(true);
                }
            }

            let Some(active) = *active_panel else {
                return Ok(true);
            };

            let assistant = unsafe {
                (ptr as *const NSWindow)
                    .as_ref()
                    .ok_or_else(|| "null permission assistant window".to_string())?
            };

            if active.granted() {
                let now = Instant::now();
                if let Some(deadline) = completion_until.as_ref().copied() {
                    if now < deadline {
                        return Ok(true);
                    }
                    *completion_until = None;
                    if let Some(source_frame) = active_source_frame
                        .as_ref()
                        .copied()
                        .map(AssistantFrameSnapshot::to_rect)
                    {
                        animate_completed_window_back_to_source(assistant, source_frame);
                        *last_frame = Some(AssistantFrameSnapshot::from_rect(source_frame));
                        *opening_until = None;
                        *returning_until =
                            Some(now + Duration::from_millis(ASSISTANT_RETURN_ANIMATION_MILLIS));
                        *returning_reason = Some(AssistantReturnReason::Completed);
                        return Ok(true);
                    }

                    let close_result = close_assistant_window(&mut window_ptr);
                    clear_assistant_runtime_state(
                        &mut active_panel,
                        &mut active_source_frame,
                        &mut payload_ptr,
                        &mut landing_payload_ptr,
                        &mut last_frame,
                        &mut opening_until,
                        &mut returning_until,
                        &mut completion_until,
                        &mut returning_reason,
                    );
                    let mut window_flow = state
                        .window_flow
                        .lock()
                        .map_err(|_| "permission assistant flow mutex poisoned".to_string())?;
                    let restore_result = restore_permission_flow_windows(&app, &mut window_flow);
                    return close_result.and(restore_result).map(|()| false);
                }

                show_assistant_completion(mtm, assistant, active)?;
                *payload_ptr = None;
                *landing_payload_ptr = None;
                *opening_until = None;
                *completion_until =
                    Some(now + Duration::from_millis(ASSISTANT_COMPLETION_HOLD_MILLIS));
                return Ok(true);
            }

            let Some(target_frame) = assistant_frame(mtm, ns_window_ptr)? else {
                let close_result = close_assistant_window(&mut window_ptr);
                clear_assistant_runtime_state(
                    &mut active_panel,
                    &mut active_source_frame,
                    &mut payload_ptr,
                    &mut landing_payload_ptr,
                    &mut last_frame,
                    &mut opening_until,
                    &mut returning_until,
                    &mut completion_until,
                    &mut returning_reason,
                );
                let mut window_flow = state
                    .window_flow
                    .lock()
                    .map_err(|_| "permission assistant flow mutex poisoned".to_string())?;
                let restore_result = restore_permission_flow_windows(&app, &mut window_flow);
                return close_result.and(restore_result).map(|()| false);
            };

            if let Some(deadline) = opening_until.as_ref().copied() {
                if Instant::now() < deadline {
                    return Ok(true);
                }
                *opening_until = None;
                *last_frame = Some(AssistantFrameSnapshot::from_rect(target_frame));
            }

            let frame = smoothed_assistant_frame(*last_frame, target_frame);
            *last_frame = Some(AssistantFrameSnapshot::from_rect(frame));

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

        let run =
            window.run_on_main_thread(move || {
                let result =
                    (|| -> Result<(), String> {
                        MainThreadMarker::new().ok_or_else(|| {
                            "run_on_main_thread closure not on main thread".to_string()
                        })?;
                        let state = app.state::<PermissionAssistantState>();
                        let mut window_ptr = state
                            .window_ptr
                            .lock()
                            .map_err(|_| "permission assistant state mutex poisoned".to_string())?;
                        let mut active_panel = state
                            .active_panel
                            .lock()
                            .map_err(|_| "permission assistant panel mutex poisoned".to_string())?;
                        let mut active_source_frame =
                            state.active_source_frame.lock().map_err(|_| {
                                "permission assistant source mutex poisoned".to_string()
                            })?;
                        let mut payload_ptr = state.payload_ptr.lock().map_err(|_| {
                            "permission assistant payload mutex poisoned".to_string()
                        })?;
                        let mut landing_payload_ptr =
                            state.landing_payload_ptr.lock().map_err(|_| {
                                "permission assistant landing payload mutex poisoned".to_string()
                            })?;
                        let mut last_frame = state
                            .last_frame
                            .lock()
                            .map_err(|_| "permission assistant frame mutex poisoned".to_string())?;
                        let mut opening_until = state.opening_until.lock().map_err(|_| {
                            "permission assistant animation mutex poisoned".to_string()
                        })?;
                        let mut returning_until = state.returning_until.lock().map_err(|_| {
                            "permission assistant return mutex poisoned".to_string()
                        })?;
                        let mut completion_until = state.completion_until.lock().map_err(|_| {
                            "permission assistant completion mutex poisoned".to_string()
                        })?;
                        let mut returning_reason = state.returning_reason.lock().map_err(|_| {
                            "permission assistant return reason mutex poisoned".to_string()
                        })?;
                        let mut target_candidate = state.target_candidate.lock().map_err(|_| {
                            "permission assistant target mutex poisoned".to_string()
                        })?;
                        let mut window_flow = state
                            .window_flow
                            .lock()
                            .map_err(|_| "permission assistant flow mutex poisoned".to_string())?;

                        let close_result = close_assistant_window(&mut window_ptr);
                        clear_assistant_runtime_state(
                            &mut active_panel,
                            &mut active_source_frame,
                            &mut payload_ptr,
                            &mut landing_payload_ptr,
                            &mut last_frame,
                            &mut opening_until,
                            &mut returning_until,
                            &mut completion_until,
                            &mut returning_reason,
                        );
                        *target_candidate = None;
                        let restore_result =
                            restore_permission_flow_windows(&app, &mut window_flow);

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
    target_frame: NSRect,
    source_rect: Option<PermissionAssistantSourceRect>,
    source_image_data_url: Option<&str>,
) -> Result<CreatedAssistantWindow, String> {
    let source_frame = source_rect
        .map(|rect| webview_rect_to_screen_frame(source_window_ptr, rect))
        .transpose()?;
    let initial_frame = source_frame.unwrap_or(target_frame);
    let should_animate_from_source = !rects_nearly_equal(initial_frame, target_frame);
    let window = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            mtm.alloc(),
            initial_frame,
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

    let content = build_assistant_content(mtm, app_path, panel, source_image_data_url)?;
    content
        .root
        .setFrame(NSRect::new(NSPoint::new(0.0, 0.0), initial_frame.size));
    if should_animate_from_source {
        content.payload.setAlphaValue(0.0);
        content.landing_payload.setAlphaValue(1.0);
    }
    let payload_ptr = Retained::as_ptr(&content.payload) as usize;
    let landing_payload_ptr = Retained::as_ptr(&content.landing_payload) as usize;
    window.setContentView(Some(&content.root));
    window.orderFrontRegardless();
    if should_animate_from_source {
        animate_view_alpha(
            &content.landing_payload,
            0.0,
            ASSISTANT_CONTENT_FADE_SECONDS,
        );
        animate_view_alpha(&content.payload, 1.0, ASSISTANT_CONTENT_FADE_SECONDS);
        animate_window_to_target(&window, target_frame);
    }

    Ok((
        window,
        target_frame,
        source_frame,
        payload_ptr,
        landing_payload_ptr,
        should_animate_from_source,
    ))
}

#[cfg(target_os = "macos")]
fn reuse_assistant_window(
    mtm: MainThreadMarker,
    window_ptr: Option<usize>,
    source_window_ptr: usize,
    app_path: &str,
    panel: PermissionPanel,
    target_frame: NSRect,
    source_rect: Option<PermissionAssistantSourceRect>,
    source_image_data_url: Option<&str>,
) -> Result<ReusedAssistantWindow, String> {
    let ptr = window_ptr.ok_or_else(|| "missing permission assistant window".to_string())?;
    let window = unsafe {
        (ptr as *const NSWindow)
            .as_ref()
            .ok_or_else(|| "null permission assistant window".to_string())?
    };
    let source_frame = source_rect
        .map(|rect| webview_rect_to_screen_frame(source_window_ptr, rect))
        .transpose()?;
    let initial_frame = source_frame.unwrap_or_else(|| window.frame());
    let content = build_assistant_content(mtm, app_path, panel, source_image_data_url)?;
    content
        .root
        .setFrame(NSRect::new(NSPoint::new(0.0, 0.0), initial_frame.size));
    content.payload.setAlphaValue(0.0);
    content.landing_payload.setAlphaValue(1.0);
    let payload_ptr = Retained::as_ptr(&content.payload) as usize;
    let landing_payload_ptr = Retained::as_ptr(&content.landing_payload) as usize;

    window.setFrame_display(initial_frame, false);
    window.setAlphaValue(1.0);
    window.setIgnoresMouseEvents(false);
    window.setContentView(Some(&content.root));
    window.orderFrontRegardless();
    animate_view_alpha(
        &content.landing_payload,
        0.0,
        ASSISTANT_CONTENT_FADE_SECONDS,
    );
    animate_view_alpha(&content.payload, 1.0, ASSISTANT_CONTENT_FADE_SECONDS);
    animate_window_to_target(window, target_frame);

    Ok((
        ptr,
        target_frame,
        source_frame,
        payload_ptr,
        landing_payload_ptr,
        true,
    ))
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
fn show_assistant_completion(
    mtm: MainThreadMarker,
    window: &NSWindow,
    panel: PermissionPanel,
) -> Result<(), String> {
    let content = build_assistant_completed_content(mtm, panel)?;
    let frame = window.frame();
    content.setFrame(NSRect::new(NSPoint::new(0.0, 0.0), frame.size));
    window.setContentView(Some(&content));
    window.setIgnoresMouseEvents(true);
    window.setAlphaValue(1.0);
    Ok(())
}

#[cfg(target_os = "macos")]
fn clear_assistant_runtime_state(
    active_panel: &mut Option<PermissionPanel>,
    active_source_frame: &mut Option<AssistantFrameSnapshot>,
    payload_ptr: &mut Option<usize>,
    landing_payload_ptr: &mut Option<usize>,
    last_frame: &mut Option<AssistantFrameSnapshot>,
    opening_until: &mut Option<Instant>,
    returning_until: &mut Option<Instant>,
    completion_until: &mut Option<Instant>,
    returning_reason: &mut Option<AssistantReturnReason>,
) {
    *active_panel = None;
    *active_source_frame = None;
    *payload_ptr = None;
    *landing_payload_ptr = None;
    *last_frame = None;
    *opening_until = None;
    *returning_until = None;
    *completion_until = None;
    *returning_reason = None;
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
fn settled_assistant_frame(
    mtm: MainThreadMarker,
    source_window_ptr: usize,
    target_candidate: &mut Option<AssistantFrameCandidate>,
) -> Result<Option<NSRect>, String> {
    let Some(target_frame) = assistant_frame(mtm, source_window_ptr)? else {
        *target_candidate = None;
        return Ok(None);
    };

    let now = Instant::now();
    if let Some(candidate) = target_candidate.as_ref() {
        if rects_nearly_equal(candidate.frame.to_rect(), target_frame) {
            if now.duration_since(candidate.since)
                >= Duration::from_millis(ASSISTANT_TARGET_SETTLE_MILLIS)
            {
                return Ok(Some(target_frame));
            }
            return Ok(None);
        }
    }

    *target_candidate = Some(AssistantFrameCandidate {
        frame: AssistantFrameSnapshot::from_rect(target_frame),
        since: now,
    });
    Ok(None)
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
    source_image_data_url: Option<&str>,
) -> Result<AssistantContentViews, String> {
    let resize_mask =
        NSAutoresizingMaskOptions::ViewWidthSizable | NSAutoresizingMaskOptions::ViewHeightSizable;
    let content = NSView::initWithFrame(
        mtm.alloc(),
        NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(530.0, 109.0)),
    );

    let material = NSVisualEffectView::initWithFrame(
        mtm.alloc(),
        NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(530.0, 109.0)),
    );
    material.setMaterial(NSVisualEffectMaterial::Popover);
    material.setAutoresizingMask(resize_mask);
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

    let payload = NSView::initWithFrame(
        mtm.alloc(),
        NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(530.0, 109.0)),
    );
    payload.setAutoresizingMask(resize_mask);

    add_label(
        &payload,
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
    payload.addSubview(&row);

    let landing_payload = build_assistant_landing_payload(mtm, panel, source_image_data_url)?;
    content.addSubview(&landing_payload);
    content.addSubview(&payload);

    Ok(AssistantContentViews {
        root: content,
        payload,
        landing_payload,
    })
}

#[cfg(target_os = "macos")]
fn build_assistant_completed_content(
    mtm: MainThreadMarker,
    panel: PermissionPanel,
) -> Result<Retained<NSView>, String> {
    let resize_mask =
        NSAutoresizingMaskOptions::ViewWidthSizable | NSAutoresizingMaskOptions::ViewHeightSizable;
    let content = NSView::initWithFrame(
        mtm.alloc(),
        NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(530.0, 109.0)),
    );

    let material = NSVisualEffectView::initWithFrame(
        mtm.alloc(),
        NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(530.0, 109.0)),
    );
    material.setMaterial(NSVisualEffectMaterial::Popover);
    material.setAutoresizingMask(resize_mask);
    material.setBlendingMode(NSVisualEffectBlendingMode::BehindWindow);
    material.setState(NSVisualEffectState::Active);
    material.setWantsLayer(true);
    style_view_layer(
        material.as_ref(),
        &NSColor::windowBackgroundColor().colorWithAlphaComponent(0.82),
        18.0,
        Some(&NSColor::systemGreenColor().colorWithAlphaComponent(0.28)),
        0.8,
    )?;
    content.addSubview(&material);

    if let Some(icon) = NSImage::imageWithSystemSymbolName_accessibilityDescription(
        &NSString::from_str("checkmark.circle.fill"),
        Some(&NSString::from_str(panel.completion_title())),
    ) {
        icon.setSize(NSSize::new(34.0, 34.0));
        icon.setTemplate(true);
        let icon_view = NSImageView::imageViewWithImage(&icon, mtm);
        icon_view.setFrame(NSRect::new(
            NSPoint::new(24.0, 38.0),
            NSSize::new(34.0, 34.0),
        ));
        icon_view.setContentTintColor(Some(&NSColor::systemGreenColor()));
        icon_view.setAutoresizingMask(
            NSAutoresizingMaskOptions::ViewMaxXMargin
                | NSAutoresizingMaskOptions::ViewMinYMargin
                | NSAutoresizingMaskOptions::ViewMaxYMargin,
        );
        content.addSubview(&icon_view);
    }

    add_label(
        &content,
        panel.completion_title(),
        NSRect::new(NSPoint::new(76.0, 58.0), NSSize::new(410.0, 24.0)),
        17.0,
        true,
        &NSColor::labelColor().colorWithAlphaComponent(0.92),
        1,
        mtm,
    );
    add_label(
        &content,
        "Returning to Macroni",
        NSRect::new(NSPoint::new(76.0, 34.0), NSSize::new(410.0, 22.0)),
        14.0,
        false,
        &NSColor::secondaryLabelColor().colorWithAlphaComponent(0.88),
        1,
        mtm,
    );

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
fn build_assistant_landing_payload(
    mtm: MainThreadMarker,
    panel: PermissionPanel,
    source_image_data_url: Option<&str>,
) -> Result<Retained<NSView>, String> {
    let resize_mask =
        NSAutoresizingMaskOptions::ViewWidthSizable | NSAutoresizingMaskOptions::ViewHeightSizable;
    let landing = NSView::initWithFrame(
        mtm.alloc(),
        NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(530.0, 109.0)),
    );
    landing.setAutoresizingMask(resize_mask);
    landing.setAlphaValue(0.0);

    if let Some(snapshot) = source_image_data_url.and_then(source_snapshot_image) {
        let snapshot_view = NSImageView::imageViewWithImage(&snapshot, mtm);
        snapshot_view.setFrame(NSRect::new(
            NSPoint::new(0.0, 0.0),
            NSSize::new(530.0, 109.0),
        ));
        snapshot_view.setAutoresizingMask(resize_mask);
        snapshot_view.setImageScaling(NSImageScaling::ScaleAxesIndependently);
        landing.addSubview(&snapshot_view);

        return Ok(landing);
    }

    if let Some(icon) = permission_gate_icon(panel) {
        icon.setSize(NSSize::new(40.0, 40.0));
        icon.setTemplate(true);
        let icon_view = NSImageView::imageViewWithImage(&icon, mtm);
        icon_view.setFrame(NSRect::new(
            NSPoint::new(24.0, 35.0),
            NSSize::new(40.0, 40.0),
        ));
        icon_view.setContentTintColor(Some(&NSColor::labelColor().colorWithAlphaComponent(0.92)));
        icon_view.setAutoresizingMask(
            NSAutoresizingMaskOptions::ViewMaxXMargin
                | NSAutoresizingMaskOptions::ViewMinYMargin
                | NSAutoresizingMaskOptions::ViewMaxYMargin,
        );
        landing.addSubview(&icon_view);
    }

    let title = NSTextField::labelWithString(&NSString::from_str(panel.allowed_target()), mtm);
    title.setFont(Some(&NSFont::boldSystemFontOfSize(18.0)));
    title.setTextColor(Some(&NSColor::labelColor().colorWithAlphaComponent(0.92)));
    title.setMaximumNumberOfLines(1);
    title.setFrame(NSRect::new(
        NSPoint::new(84.0, 58.0),
        NSSize::new(268.0, 24.0),
    ));
    title.setAutoresizingMask(
        NSAutoresizingMaskOptions::ViewWidthSizable
            | NSAutoresizingMaskOptions::ViewMinYMargin
            | NSAutoresizingMaskOptions::ViewMaxYMargin,
    );
    landing.addSubview(&title);

    let description =
        NSTextField::labelWithString(&NSString::from_str(panel.gate_description()), mtm);
    description.setFont(Some(&NSFont::systemFontOfSize(14.0)));
    description.setTextColor(Some(
        &NSColor::secondaryLabelColor().colorWithAlphaComponent(0.9),
    ));
    description.setMaximumNumberOfLines(1);
    description.setFrame(NSRect::new(
        NSPoint::new(84.0, 35.0),
        NSSize::new(268.0, 20.0),
    ));
    description.setAutoresizingMask(
        NSAutoresizingMaskOptions::ViewWidthSizable
            | NSAutoresizingMaskOptions::ViewMinYMargin
            | NSAutoresizingMaskOptions::ViewMaxYMargin,
    );
    landing.addSubview(&description);

    let button = NSView::initWithFrame(
        mtm.alloc(),
        NSRect::new(NSPoint::new(394.0, 33.0), NSSize::new(112.0, 44.0)),
    );
    button.setAutoresizingMask(
        NSAutoresizingMaskOptions::ViewMinXMargin
            | NSAutoresizingMaskOptions::ViewMinYMargin
            | NSAutoresizingMaskOptions::ViewMaxYMargin,
    );
    style_view_layer(
        &button,
        &NSColor::systemBlueColor().colorWithAlphaComponent(0.96),
        12.0,
        None,
        0.0,
    )?;
    landing.addSubview(&button);

    add_centered_label(
        &button,
        "Allow",
        NSRect::new(NSPoint::new(0.0, 12.0), NSSize::new(112.0, 20.0)),
        14.0,
        true,
        &NSColor::whiteColor().colorWithAlphaComponent(0.98),
        mtm,
    );

    Ok(landing)
}

#[cfg(target_os = "macos")]
fn permission_gate_icon(panel: PermissionPanel) -> Option<Retained<NSImage>> {
    let description = NSString::from_str(panel.allowed_target());
    NSImage::imageWithSystemSymbolName_accessibilityDescription(
        &NSString::from_str(panel.gate_symbol_name()),
        Some(&description),
    )
    .or_else(|| {
        NSImage::imageWithSystemSymbolName_accessibilityDescription(
            &NSString::from_str(panel.gate_symbol_fallback_name()),
            Some(&description),
        )
    })
}

#[cfg(target_os = "macos")]
fn source_snapshot_image(data_url: &str) -> Option<Retained<NSImage>> {
    if !data_url.starts_with("data:image/") {
        return None;
    }

    let (_, encoded) = data_url.split_once(',')?;
    let data = NSData::initWithBase64EncodedString_options(
        NSData::alloc(),
        &NSString::from_str(encoded),
        NSDataBase64DecodingOptions::IgnoreUnknownCharacters,
    )?;

    NSImage::initWithData(NSImage::alloc(), &data)
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
fn add_centered_label(
    parent: &NSView,
    text: &str,
    frame: NSRect,
    font_size: f64,
    bold: bool,
    color: &NSColor,
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
    label.setAlignment(NSTextAlignment(2));
    label.setMaximumNumberOfLines(1);
    label.setFrame(frame);
    label.setAutoresizingMask(
        NSAutoresizingMaskOptions::ViewWidthSizable
            | NSAutoresizingMaskOptions::ViewMinYMargin
            | NSAutoresizingMaskOptions::ViewMaxYMargin,
    );
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
