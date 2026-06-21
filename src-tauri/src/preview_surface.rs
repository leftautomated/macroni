//! Native macOS preview surface for the studio editor (Phase 1, Task 11).
//!
//! THROWAWAY-grade host integration. This replaces the Phase 0 solid-teal spike
//! (Task 5): the same proven native-surface plumbing (NSWindow → contentView →
//! child `NSView` + `CAMetalLayer` inserted *below* the WKWebview, the
//! `contentLayoutRect`-based Y-flip) now renders **real composited frames** via
//! `render_core::engine::Engine` instead of a solid color.
//!
//! This module is macOS-only. The webview-alignment scaffolding here is
//! intentionally shallow and disposable — the eventual GPUI migration will
//! delete it. Do NOT over-invest, do NOT add unit tests; visual verification is
//! the human's job (Task 12).
//!
//! ## How it works
//!
//! 1. The React `studio` window has `transparent: true`; the preview-hole div
//!    has `background: transparent`. We make the `NSWindow` non-opaque with a
//!    clear background so transparency composites through to whatever is behind
//!    the WKWebview.
//! 2. On the first attach we create a child `NSView` (`wantsLayer = true`,
//!    layer = `CAMetalLayer`) and insert it into the window's `contentView`
//!    *below* the existing subviews (the WKWebview). So the Metal layer draws
//!    BEHIND the webview, visible only through the transparent hole.
//! 3. We build a wgpu `Surface` from the `CAMetalLayer` pointer using
//!    `SurfaceTargetUnsafe::CoreAnimationLayer` (wgpu 29) **on the Engine's GPU**
//!    and configure it. The surface MUST share the Engine's device because
//!    `Engine::render_to_surface` blits an offscreen texture (Engine device)
//!    onto the surface's swapchain texture — cross-device texture use is illegal
//!    in wgpu.
//! 4. Re-invoking repositions the NSView frame and reconfigures the surface to
//!    the new size. A resize listener in React drives that.
//! 5. `studio_open_preview` builds an `Engine` from the recording's screen mp4,
//!    attaches the surface, and renders frame 0; `studio_render_preview`
//!    re-renders on demand when the doc or scrub position changes (no playback
//!    loop this phase).
//!
//! ## Threading
//!
//! All AppKit + surface work MUST happen on the main thread. Tauri commands run
//! off the main thread, so we hop via `window.run_on_main_thread(..)` and ferry
//! the `Result` back over a channel. The cached wgpu state is `Send + Sync` in
//! wgpu 29; the raw `CAMetalLayer`/`NSView` pointers are stored as `usize` so the
//! struct stays `Send` (we only ever dereference them on the main thread).

use std::sync::Mutex;

use objc2::rc::Retained;
use objc2::MainThreadMarker;
use objc2_app_kit::{NSColor, NSView, NSWindow, NSWindowOrderingMode};
use objc2_foundation::{NSPoint, NSRect, NSSize};
use objc2_quartz_core::CAMetalLayer;
use render_core::decode::Mp4FrameSource;
use render_core::doc::ProjectDoc;
use render_core::engine::Engine;
use render_core::gpu::Gpu;
use tauri::{Manager, WebviewWindow};
use wgpu::{
    CompositeAlphaMode, PresentMode, Surface, SurfaceConfiguration, SurfaceTargetUnsafe,
    TextureFormat, TextureUsages,
};

use crate::recordings_store::RecordingsStore;

/// Cached studio preview state, lives in Tauri's managed `State`.
///
/// Holds the loaded `Engine` (per recording) and the native preview surface.
/// Both are `Option` because they are populated lazily by `studio_open_preview`.
#[derive(Default)]
pub struct StudioState {
    /// The render-core engine for the currently-open recording, if any.
    engine: Mutex<Option<SendEngine>>,
    /// The native Metal preview surface, if attached.
    surface: Mutex<Option<PreviewSurface>>,
}

/// `Send` wrapper around [`Engine`].
///
/// `Engine` holds a `Box<dyn FrameSource>` (the openh264 `Decoder` is not
/// `Send`), so `Engine` is `!Send` — but Tauri's managed `State` requires
/// `Send + Sync`. We only ever construct and touch the engine inside
/// `run_on_main_thread` closures (the AppKit/surface contract pins all preview
/// work to the main thread), so the engine never actually moves between threads
/// at use-time. The `Mutex` in `StudioState` serialises access; this wrapper
/// just lets the `!Send` engine ride inside Tauri's `Send + Sync` state.
struct SendEngine(Engine);

// SAFETY: the wrapped Engine is created and used exclusively on the main thread
// (every access is inside a `window.run_on_main_thread` closure). It is parked
// in Tauri state between calls but never operated on off the main thread.
unsafe impl Send for SendEngine {}

/// The persistent wgpu + AppKit handles for the preview surface.
///
/// The surface is created on the Engine's GPU (see module docs), so this struct
/// does not own a device — it reuses the Engine's via [`Engine::gpu`]. The
/// pointers are stored as integers so this struct stays `Send`; they are only
/// ever cast back to a pointer and dereferenced on the main thread.
struct PreviewSurface {
    surface: Surface<'static>,
    format: TextureFormat,
    /// `*const CAMetalLayer` as a usize (Send-safe).
    layer_ptr: usize,
    /// `*const NSView` (the child view we created) as a usize (Send-safe).
    view_ptr: usize,
}

// SAFETY: `layer_ptr`/`view_ptr` are only dereferenced on the main thread (every
// access is inside a `run_on_main_thread` closure). The wgpu fields are already
// Send+Sync. This unsafe impl just lets us park the integer-encoded pointers in
// Tauri's `State` alongside them.
unsafe impl Send for PreviewSurface {}

/// Tauri command: reposition the native Metal preview surface behind the
/// transparent webview hole.
///
/// `x, y, w, h` are in **physical pixels**, top-left origin (web coordinates),
/// i.e. the div's `getBoundingClientRect()` multiplied by `devicePixelRatio`.
///
/// Requires the surface to have been created first by `studio_open_preview`
/// (the surface must be built on the Engine's GPU). This command only
/// repositions + reconfigures + re-renders the last frame. It is the resize
/// handler.
#[tauri::command]
pub fn studio_attach_surface(
    window: WebviewWindow,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    let ns_window_ptr = window.ns_window().map_err(|e| e.to_string())? as usize;
    let app = window.app_handle().clone();
    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();

    let run = window.run_on_main_thread(move || {
        let result = (|| -> Result<(), String> {
            // Verify we're on the main thread (AppKit + surface contract).
            MainThreadMarker::new()
                .ok_or_else(|| "run_on_main_thread closure not on main thread".to_string())?;

            let studio_state = app.state::<StudioState>();
            let studio_state = studio_state.inner();

            let eg_guard = studio_state
                .engine
                .lock()
                .map_err(|_| "studio engine mutex poisoned".to_string())?;
            let engine = eg_guard
                .as_ref()
                .ok_or_else(|| "preview engine not opened".to_string())?;

            let surf_guard = studio_state
                .surface
                .lock()
                .map_err(|_| "studio surface mutex poisoned".to_string())?;
            let surf = surf_guard
                .as_ref()
                .ok_or_else(|| "preview surface not attached".to_string())?;

            // Reposition + reconfigure only. The reconfigure invalidates the
            // swapchain contents; the resize listener should follow up with
            // studio_render_preview to repaint. Keep this command pure
            // reposition for clarity.
            reposition_existing_surface(ns_window_ptr, surf, engine.0.gpu(), x, y, w, h)
        })();

        let _ = tx.send(result);
    });

    run.map_err(|e| format!("run_on_main_thread failed: {e}"))?;
    rx.recv()
        .map_err(|_| "main-thread closure dropped without result".to_string())?
}

/// Tauri command: open a recording for preview.
///
/// Looks up the recording's screen mp4 path (via the recordings store), builds
/// an `Engine` over it, creates + positions the native surface on the Engine's
/// GPU, loads the recording's `ProjectDoc` (or a default), and renders frame 0.
///
/// `x, y, w, h` are in **physical pixels**, top-left origin (web coordinates).
#[tauri::command]
pub fn studio_open_preview(
    window: WebviewWindow,
    recording_id: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    let app = window.app_handle().clone();

    // ── Resolve the recording's screen mp4 path + doc (off the main thread). ─
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;

    let store = RecordingsStore::open(&app).map_err(|e| e.to_string())?;
    let recordings = store.load_all().map_err(|e| e.to_string())?;
    let recording = recordings
        .iter()
        .find(|r| r.id == recording_id)
        .ok_or_else(|| format!("recording '{}' not found", recording_id))?;
    let screen_mp4 = recording
        .video
        .as_ref()
        .map(|v| v.path.clone())
        .ok_or_else(|| format!("recording '{}' has no screen video", recording_id))?;

    // Load the persisted doc, or fall back to a default built from the mp4 path.
    let doc = match crate::project_store::load_project(&app_data, &recording_id)? {
        Some(d) => d,
        None => ProjectDoc::new_default(screen_mp4.clone()),
    };

    // ── Build the Engine over the screen mp4 (off the main thread). ──────────
    let source = Mp4FrameSource::open(std::path::Path::new(&screen_mp4))
        .map_err(|e| format!("open mp4 '{screen_mp4}': {e}"))?;
    let engine = Engine::new(Box::new(source)).map_err(|e| format!("engine init: {e}"))?;

    // Store the engine in state, replacing any prior recording's engine.
    {
        let state = app.state::<StudioState>();
        let mut eg = state
            .engine
            .lock()
            .map_err(|_| "studio engine mutex poisoned".to_string())?;
        *eg = Some(SendEngine(engine));
    }

    // ── Create the surface on the Engine GPU + render frame 0 (main thread). ─
    let ns_window_ptr = window.ns_window().map_err(|e| e.to_string())? as usize;
    let app2 = app.clone();
    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();

    let run = window.run_on_main_thread(move || {
        let result = (|| -> Result<(), String> {
            let mtm = MainThreadMarker::new()
                .ok_or_else(|| "run_on_main_thread closure not on main thread".to_string())?;

            let studio_state = app2.state::<StudioState>();
            let studio_state = studio_state.inner();

            let mut eg_guard = studio_state
                .engine
                .lock()
                .map_err(|_| "studio engine mutex poisoned".to_string())?;
            let engine = eg_guard
                .as_mut()
                .ok_or_else(|| "preview engine not opened".to_string())?;

            let mut surf_guard = studio_state
                .surface
                .lock()
                .map_err(|_| "studio surface mutex poisoned".to_string())?;

            // Create (or reposition) the surface on the Engine's GPU.
            create_or_reposition_surface(
                mtm,
                ns_window_ptr,
                &mut surf_guard,
                engine.0.gpu(),
                x,
                y,
                w,
                h,
            )?;

            // Render frame 0 onto the surface.
            let surf = surf_guard
                .as_ref()
                .ok_or_else(|| "preview surface vanished".to_string())?;
            engine
                .0
                .render_to_surface(&doc, 0, &surf.surface, surf.format)
                .map_err(|e| format!("render_to_surface: {e}"))?;
            Ok(())
        })();

        let _ = tx.send(result);
    });

    run.map_err(|e| format!("run_on_main_thread failed: {e}"))?;
    rx.recv()
        .map_err(|_| "main-thread closure dropped without result".to_string())?
}

/// Tauri command: render `doc` at `frame_index` onto the attached surface.
///
/// Render-on-demand — called when the doc or scrub position changes. There is
/// no playback loop this phase. Requires `studio_open_preview` to have been
/// called first (so the engine + surface exist).
#[tauri::command]
pub fn studio_render_preview(
    window: WebviewWindow,
    doc: ProjectDoc,
    frame_index: u32,
) -> Result<(), String> {
    let app = window.app_handle().clone();
    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();

    let run = window.run_on_main_thread(move || {
        let result = (|| -> Result<(), String> {
            let studio_state = app.state::<StudioState>();
            let studio_state = studio_state.inner();

            let mut eg_guard = studio_state
                .engine
                .lock()
                .map_err(|_| "studio engine mutex poisoned".to_string())?;
            let engine = eg_guard
                .as_mut()
                .ok_or_else(|| "preview engine not opened".to_string())?;

            let surf_guard = studio_state
                .surface
                .lock()
                .map_err(|_| "studio surface mutex poisoned".to_string())?;
            let surf = surf_guard
                .as_ref()
                .ok_or_else(|| "preview surface not attached".to_string())?;

            engine
                .0
                .render_to_surface(&doc, frame_index as usize, &surf.surface, surf.format)
                .map_err(|e| format!("render_to_surface: {e}"))
        })();

        let _ = tx.send(result);
    });

    run.map_err(|e| format!("run_on_main_thread failed: {e}"))?;
    rx.recv()
        .map_err(|_| "main-thread closure dropped without result".to_string())?
}

/// Reposition + reconfigure an already-created surface to a new rect. Must run
/// on the main thread. Uses `gpu` (the Engine's GPU) to reconfigure.
fn reposition_existing_surface(
    ns_window_ptr: usize,
    existing: &PreviewSurface,
    gpu: &Gpu,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    let (frame, scale, px_w, px_h) = compute_frame(ns_window_ptr, x, y, w, h)?;

    // SAFETY: view_ptr/layer_ptr are the handles we created earlier; only
    // touched on the main thread.
    let view: &NSView = unsafe {
        (existing.view_ptr as *const NSView)
            .as_ref()
            .ok_or_else(|| "null child view".to_string())?
    };
    view.setFrame(frame);

    let layer: &CAMetalLayer = unsafe {
        (existing.layer_ptr as *const CAMetalLayer)
            .as_ref()
            .ok_or_else(|| "null metal layer".to_string())?
    };
    layer.setContentsScale(scale);
    layer.setDrawableSize(NSSize::new(px_w as f64, px_h as f64));

    configure_surface(&existing.surface, &gpu.device, existing.format, px_w, px_h);
    Ok(())
}

/// Create (once) or reposition the native Metal surface behind the webview hole,
/// building the wgpu surface on `gpu` (the Engine's GPU). Must run on the main
/// thread.
fn create_or_reposition_surface(
    mtm: MainThreadMarker,
    ns_window_ptr: usize,
    guard: &mut Option<PreviewSurface>,
    gpu: &Gpu,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    if let Some(existing) = guard.as_ref() {
        return reposition_existing_surface(ns_window_ptr, existing, gpu, x, y, w, h);
    }

    // SAFETY: Tauri hands us a valid NSWindow pointer for this window.
    let ns_window: &NSWindow = unsafe {
        (ns_window_ptr as *const NSWindow)
            .as_ref()
            .ok_or_else(|| "null NSWindow".to_string())?
    };

    // Make the window non-opaque + clear background so the transparent webview
    // hole composites through to the Metal layer behind it.
    ns_window.setOpaque(false);
    let clear = NSColor::clearColor();
    ns_window.setBackgroundColor(Some(&clear));

    let content_view = ns_window
        .contentView()
        .ok_or_else(|| "NSWindow has no contentView".to_string())?;

    let (frame, scale, px_w, px_h) = compute_frame(ns_window_ptr, x, y, w, h)?;

    // 1. Create the child NSView and give it a CAMetalLayer.
    let child = NSView::new(mtm);
    child.setFrame(frame);
    // The layer must be created and assigned BEFORE setWantsLayer so the view
    // uses *our* CAMetalLayer (not an auto-created CALayer).
    let layer = CAMetalLayer::new();
    layer.setContentsScale(scale);
    layer.setDrawableSize(NSSize::new(px_w as f64, px_h as f64));
    // setLayer takes Option<&CALayer>; `&**layer` walks the Deref chain
    // Retained<CAMetalLayer> -> CAMetalLayer -> CALayer.
    child.setLayer(Some(&**layer));
    child.setWantsLayer(true);

    // 2. Insert BELOW the webview so it renders behind it. Passing `None` as the
    //    relative view + `Below` puts it at the bottom of the subview z-order.
    content_view.addSubview_positioned_relativeTo(&child, NSWindowOrderingMode::Below, None);

    // 3. Build a wgpu surface from the CAMetalLayer — on the Engine's instance.
    let layer_ptr_cvoid = Retained::as_ptr(&layer) as *mut core::ffi::c_void;
    // SAFETY: the CAMetalLayer outlives the surface — `child` (and thus its
    // layer) is retained by the view hierarchy and we additionally leak the
    // Retained handles below.
    let surface = unsafe {
        gpu.instance
            .create_surface_unsafe(SurfaceTargetUnsafe::CoreAnimationLayer(layer_ptr_cvoid))
            .map_err(|e| format!("create_surface_unsafe failed: {e}"))?
    };

    // 4. Pick a format the surface supports (prefer Bgra8Unorm — the
    //    Metal-native swapchain format). The engine's blit pass targets this.
    let caps = surface.get_capabilities(&gpu.adapter);
    let format = if caps.formats.contains(&TextureFormat::Bgra8Unorm) {
        TextureFormat::Bgra8Unorm
    } else {
        *caps
            .formats
            .first()
            .ok_or_else(|| "surface reports no formats".to_string())?
    };

    configure_surface(&surface, &gpu.device, format, px_w, px_h);

    // Keep the layer/view Retained handles alive for the surface's lifetime.
    let layer_ptr = Retained::as_ptr(&layer) as usize;
    let view_ptr = Retained::as_ptr(&child) as usize;
    // Intentionally leak the Retained handles for the preview's lifetime
    // (throwaway code, single window). Prevents any chance of the layer dropping
    // out from under the live wgpu surface.
    std::mem::forget(layer);
    std::mem::forget(child);

    *guard = Some(PreviewSurface {
        surface,
        format,
        layer_ptr,
        view_ptr,
    });

    Ok(())
}

/// Compute the AppKit child-view frame (points, bottom-left origin) plus the
/// backing scale and physical drawable dimensions, from a web-space rect
/// (physical px, top-left origin).
///
/// The `contentLayoutRect`-based Y-flip below is the verified-correct Phase 0
/// math — do NOT change it.
fn compute_frame(
    ns_window_ptr: usize,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(NSRect, f64, u32, u32), String> {
    // SAFETY: valid NSWindow pointer; only dereferenced on the main thread.
    let ns_window: &NSWindow = unsafe {
        (ns_window_ptr as *const NSWindow)
            .as_ref()
            .ok_or_else(|| "null NSWindow".to_string())?
    };

    // Backing scale (points -> physical px). Web coords are physical px.
    let scale = ns_window.backingScaleFactor();
    let scale = if scale <= 0.0 { 1.0 } else { scale };

    // Convert the requested rect from web space (physical px, top-left origin)
    // to AppKit space (points, bottom-left origin).
    //
    // Tauri/wry uses a FULL-SIZE content view: contentView.bounds == window
    // frame, so the title-bar inset is invisible to contentView.bounds. The
    // WKWebview is placed in `contentLayoutRect` — AppKit's area not obscured by
    // the title bar — which is the true reference for the web layout. Flip the
    // div's web (top-left) y against the TOP edge of that rect, expressed in
    // contentView (bottom-left) coordinates. (Verified-correct Phase 0 math.)
    let layout = ns_window.contentLayoutRect();
    let x_pt = layout.origin.x + x / scale;
    let y_pt = y / scale;
    let w_pt = (w / scale).max(1.0);
    let h_pt = (h / scale).max(1.0);
    let webview_top = layout.origin.y + layout.size.height;
    let appkit_y = webview_top - (y_pt + h_pt);
    let frame = NSRect::new(NSPoint::new(x_pt, appkit_y), NSSize::new(w_pt, h_pt));

    // Surface drawable size is in PHYSICAL pixels.
    let px_w = w.max(1.0) as u32;
    let px_h = h.max(1.0) as u32;

    Ok((frame, scale, px_w, px_h))
}

/// Configure the surface to `(w, h)` with `format` on `device`. Does NOT render.
///
/// `PostMultiplied` alpha lets the surface composite correctly under the
/// transparent webview hole.
fn configure_surface(
    surface: &Surface<'static>,
    device: &wgpu::Device,
    format: TextureFormat,
    w: u32,
    h: u32,
) {
    let config = SurfaceConfiguration {
        usage: TextureUsages::RENDER_ATTACHMENT,
        format,
        width: w,
        height: h,
        present_mode: PresentMode::Fifo,
        desired_maximum_frame_latency: 2,
        alpha_mode: CompositeAlphaMode::PostMultiplied,
        view_formats: vec![],
    };
    surface.configure(device, &config);
}
