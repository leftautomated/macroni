//! Phase 0 spike (Task 5) — THROWAWAY discovery code.
//!
//! Proves "Unknown A" from the studio-editor design spec: can a native
//! wgpu/Metal surface render UNDER a transparent region of macroni's WKWebview
//! and stay aligned to a React `<div>` across resizes?
//!
//! This module is macOS-only. Everything here is intentionally shallow and
//! disposable — it is the webview-alignment scaffolding that the eventual GPUI
//! migration will delete. Do NOT over-invest, do NOT add unit tests.
//!
//! ## How it works
//!
//! 1. The React `studio` window has `transparent: true`; the `#preview-hole`
//!    div has `background: transparent`. We make the `NSWindow` non-opaque with
//!    a clear background so transparency composites through to whatever is
//!    behind the WKWebview.
//! 2. On the first `spike_show_surface` call we create a child `NSView`
//!    (`wantsLayer = true`, layer = `CAMetalLayer`) and insert it into the
//!    window's `contentView` *below* the existing subviews (the WKWebview) via
//!    `addSubview:positioned:relativeTo:` with `NSWindowOrderingMode::Below`.
//!    So the Metal layer draws BEHIND the webview, visible only through the
//!    transparent hole.
//! 3. We build a wgpu `Surface` from the `CAMetalLayer` pointer using
//!    `SurfaceTargetUnsafe::CoreAnimationLayer` (wgpu 29), configure it, render
//!    a solid color, and `present()`.
//! 4. Re-invoking repositions the NSView frame, reconfigures the surface to the
//!    new size, and re-renders. A resize listener in React drives that.
//!
//! ## Threading
//!
//! All AppKit + surface work MUST happen on the main thread. Tauri commands run
//! off the main thread, so we hop via `window.run_on_main_thread(..)` and ferry
//! the `Result` back over a channel. The persistent state we cache
//! (`Instance`/`Adapter`/`Device`/`Queue`/`Surface`) is `Send + Sync` in wgpu
//! 29; the raw `CAMetalLayer` pointer is stored as a `usize` so the struct stays
//! `Send` (we only ever dereference it on the main thread).

use std::sync::Mutex;

use objc2::rc::Retained;
use objc2::MainThreadMarker;
use objc2_app_kit::{NSColor, NSView, NSWindow, NSWindowOrderingMode};
use objc2_foundation::{NSPoint, NSRect, NSSize};
use objc2_quartz_core::CAMetalLayer;
use tauri::{Manager, WebviewWindow};
use wgpu::{
    CompositeAlphaMode, Instance, PresentMode, Surface, SurfaceConfiguration, SurfaceTargetUnsafe,
    TextureFormat, TextureUsages,
};

/// Cached spike state, lives in Tauri's managed `State`.
#[derive(Default)]
pub struct SpikeState {
    inner: Mutex<Option<SpikeSurface>>,
}

/// The persistent wgpu + AppKit handles for the spike surface.
///
/// All fields except `layer_ptr` are `Send + Sync` (wgpu 29). `layer_ptr` is the
/// `CAMetalLayer` address stored as an integer so this struct stays `Send`; it
/// is only ever cast back to a pointer and dereferenced on the main thread.
struct SpikeSurface {
    _instance: Instance,
    _adapter: wgpu::Adapter,
    device: wgpu::Device,
    queue: wgpu::Queue,
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
unsafe impl Send for SpikeSurface {}

/// Tauri command: create (once) or reposition the native Metal preview surface
/// behind the transparent webview hole, then render a solid color.
///
/// `x, y, w, h` are in **physical pixels**, top-left origin (web coordinates),
/// i.e. the div's `getBoundingClientRect()` multiplied by `devicePixelRatio`.
#[tauri::command]
pub fn spike_show_surface(
    window: WebviewWindow,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    // Grab the NSWindow pointer on whatever thread we're on (it's just a
    // pointer; we won't touch AppKit until we're on the main thread).
    let ns_window_ptr = window.ns_window().map_err(|e| e.to_string())? as usize;

    // The managed `SpikeState` is reached via the app handle inside the
    // main-thread closure (`tauri::State` isn't `'static` / `Send`).
    let app = window.app_handle().clone();

    // Channel to ferry the Result back from the main thread.
    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();

    let run = window.run_on_main_thread(move || {
        let result = (|| -> Result<(), String> {
            let mtm = MainThreadMarker::new()
                .ok_or_else(|| "run_on_main_thread closure not on main thread".to_string())?;

            let spike_state = app.state::<SpikeState>();
            let mut guard = spike_state
                .inner
                .lock()
                .map_err(|_| "spike state mutex poisoned".to_string())?;

            // SAFETY: Tauri hands us a valid NSWindow pointer for this window.
            let ns_window: &NSWindow = unsafe {
                (ns_window_ptr as *const NSWindow)
                    .as_ref()
                    .ok_or_else(|| "null NSWindow".to_string())?
            };

            // Make the window non-opaque + clear background so the transparent
            // webview hole composites through to the Metal layer behind it.
            ns_window.setOpaque(false);
            let clear = NSColor::clearColor();
            ns_window.setBackgroundColor(Some(&clear));

            let content_view = ns_window
                .contentView()
                .ok_or_else(|| "NSWindow has no contentView".to_string())?;

            // Backing scale (points -> physical px). Web coords are physical px.
            let scale = ns_window.backingScaleFactor();
            let scale = if scale <= 0.0 { 1.0 } else { scale };

            // Convert the requested rect from web space (physical px, top-left
            // origin) to AppKit space (points, bottom-left origin).
            //
            //   x_pt = x / scale
            //   w_pt = w / scale,  h_pt = h / scale
            //   content height in points = window content-rect height (below title bar)
            //   appkit_y = content_height_pt - (y_pt + h_pt)
            //
            // NOTE: we must flip against the *content rect* height, NOT
            // contentView.bounds().height. Tauri/wry uses a full-size content
            // view, so contentView spans *under* the title bar while the
            // WKWebview (the reference for the web layout / getBoundingClientRect)
            // is inset below it. Flipping against the full contentView height
            // shifts the surface UP by the title-bar height. contentRectForFrameRect
            // yields the correct content-area height for both full-size and
            // standard decorated windows.
            let x_pt = x / scale;
            let y_pt = y / scale;
            let w_pt = (w / scale).max(1.0);
            let h_pt = (h / scale).max(1.0);
            let content_rect = ns_window.contentRectForFrameRect(ns_window.frame());
            let content_h_pt = content_rect.size.height;
            let appkit_y = content_h_pt - (y_pt + h_pt);
            let frame = NSRect::new(NSPoint::new(x_pt, appkit_y), NSSize::new(w_pt, h_pt));

            // Surface drawable size is in PHYSICAL pixels.
            let px_w = w.max(1.0) as u32;
            let px_h = h.max(1.0) as u32;

            if let Some(existing) = guard.as_mut() {
                // ── Reposition + reconfigure + re-render ───────────────────
                // SAFETY: view_ptr is the child NSView we created earlier; only
                // touched on the main thread.
                let view: &NSView = unsafe {
                    (existing.view_ptr as *const NSView)
                        .as_ref()
                        .ok_or_else(|| "null child view".to_string())?
                };
                view.setFrame(frame);

                // SAFETY: layer_ptr is the CAMetalLayer owned by `view`'s layer.
                let layer: &CAMetalLayer = unsafe {
                    (existing.layer_ptr as *const CAMetalLayer)
                        .as_ref()
                        .ok_or_else(|| "null metal layer".to_string())?
                };
                layer.setContentsScale(scale);
                layer.setDrawableSize(NSSize::new(px_w as f64, px_h as f64));

                reconfigure_and_render(
                    &existing.surface,
                    &existing.device,
                    &existing.queue,
                    existing.format,
                    px_w,
                    px_h,
                )?;
                return Ok(());
            }

            // ── First call: build everything ──────────────────────────────

            // 1. Create the child NSView and give it a CAMetalLayer.
            let child = NSView::new(mtm);
            child.setFrame(frame);
            // The layer must be created and assigned BEFORE setWantsLayer so the
            // view uses *our* CAMetalLayer (not an auto-created CALayer).
            let layer = CAMetalLayer::new();
            layer.setContentsScale(scale);
            layer.setDrawableSize(NSSize::new(px_w as f64, px_h as f64));
            // setLayer takes Option<&CALayer>; `&**layer` walks the Deref chain
            // Retained<CAMetalLayer> -> CAMetalLayer -> CALayer.
            child.setLayer(Some(&**layer));
            child.setWantsLayer(true);

            // 2. Insert BELOW the webview so it renders behind it. Passing
            //    `None` as the relative view + `Below` puts it at the bottom of
            //    the subview z-order.
            content_view.addSubview_positioned_relativeTo(
                &child,
                NSWindowOrderingMode::Below,
                None,
            );

            // 3. Build a wgpu surface from the CAMetalLayer.
            // `Instance::default()` enables all backends for the platform (Metal
            // on macOS); good enough for the spike.
            let instance = Instance::default();

            let layer_ptr_cvoid = Retained::as_ptr(&layer) as *mut core::ffi::c_void;
            // SAFETY: the CAMetalLayer outlives the surface — `child` (and thus
            // its layer) is retained by the view hierarchy and the layer's
            // Retained handle is moved into SpikeSurface below.
            let surface = unsafe {
                instance
                    .create_surface_unsafe(SurfaceTargetUnsafe::CoreAnimationLayer(layer_ptr_cvoid))
                    .map_err(|e| format!("create_surface_unsafe failed: {e}"))?
            };

            // 4. Adapter + device, compatible with this surface for correctness.
            let adapter = pollster::block_on(instance.request_adapter(
                &wgpu::RequestAdapterOptions {
                    power_preference: wgpu::PowerPreference::HighPerformance,
                    force_fallback_adapter: false,
                    compatible_surface: Some(&surface),
                },
            ))
            .map_err(|e| format!("no compatible adapter: {e}"))?;

            let (device, queue) = pollster::block_on(
                adapter.request_device(&wgpu::DeviceDescriptor {
                    label: Some("spike_preview_device"),
                    ..Default::default()
                }),
            )
            .map_err(|e| format!("request_device failed: {e}"))?;

            // 5. Pick a format the surface supports (prefer Bgra8Unorm — the
            //    Metal-native swapchain format).
            let caps = surface.get_capabilities(&adapter);
            let format = if caps.formats.contains(&TextureFormat::Bgra8Unorm) {
                TextureFormat::Bgra8Unorm
            } else {
                *caps
                    .formats
                    .first()
                    .ok_or_else(|| "surface reports no formats".to_string())?
            };

            reconfigure_and_render(&surface, &device, &queue, format, px_w, px_h)?;

            // Keep the layer Retained handle alive for the lifetime of the
            // surface. We store the raw pointer (as usize) for repositioning,
            // and move the Retained into the cached struct via leak so it never
            // drops while the surface references it. The view hierarchy also
            // retains the view+layer, so this is belt-and-suspenders.
            let layer_ptr = Retained::as_ptr(&layer) as usize;
            let view_ptr = Retained::as_ptr(&child) as usize;
            // Intentionally leak the Retained handles for the spike's lifetime
            // (throwaway code, single window). Prevents any chance of the layer
            // dropping out from under the live wgpu surface.
            std::mem::forget(layer);
            std::mem::forget(child);

            *guard = Some(SpikeSurface {
                _instance: instance,
                _adapter: adapter,
                device,
                queue,
                surface,
                format,
                layer_ptr,
                view_ptr,
            });

            Ok(())
        })();

        let _ = tx.send(result);
    });

    run.map_err(|e| format!("run_on_main_thread failed: {e}"))?;

    rx.recv()
        .map_err(|_| "main-thread closure dropped without result".to_string())?
}

/// Configure the surface to `(w, h)` and render a solid color, then present.
///
/// Solid color is sufficient for the spike (offscreen compositing is already
/// proven in Task 4). We use a vivid teal so it's unmistakable against the
/// dashed-red div border in the React UI.
fn reconfigure_and_render(
    surface: &Surface<'static>,
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    format: TextureFormat,
    w: u32,
    h: u32,
) -> Result<(), String> {
    let config = SurfaceConfiguration {
        usage: TextureUsages::RENDER_ATTACHMENT,
        format,
        width: w,
        height: h,
        present_mode: PresentMode::Fifo,
        desired_maximum_frame_latency: 2,
        // The window/webview hole is transparent; PostMultiplied lets the
        // surface alpha composite correctly under the webview if needed.
        alpha_mode: CompositeAlphaMode::PostMultiplied,
        view_formats: vec![],
    };
    surface.configure(device, &config);

    // wgpu 29: get_current_texture returns a CurrentSurfaceTexture enum (not a
    // Result). Success/Suboptimal both carry a usable SurfaceTexture.
    let frame = match surface.get_current_texture() {
        wgpu::CurrentSurfaceTexture::Success(t) | wgpu::CurrentSurfaceTexture::Suboptimal(t) => t,
        other => return Err(format!("get_current_texture: {other:?}")),
    };
    let view = frame
        .texture
        .create_view(&wgpu::TextureViewDescriptor::default());

    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
        label: Some("spike_preview_encoder"),
    });
    {
        let _pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("spike_preview_pass"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &view,
                resolve_target: None,
                depth_slice: None,
                ops: wgpu::Operations {
                    // Vivid teal, fully opaque.
                    load: wgpu::LoadOp::Clear(wgpu::Color {
                        r: 0.05,
                        g: 0.65,
                        b: 0.70,
                        a: 1.0,
                    }),
                    store: wgpu::StoreOp::Store,
                },
            })],
            depth_stencil_attachment: None,
            timestamp_writes: None,
            occlusion_query_set: None,
            multiview_mask: None,
        });
    }

    queue.submit(std::iter::once(encoder.finish()));
    frame.present();
    Ok(())
}
