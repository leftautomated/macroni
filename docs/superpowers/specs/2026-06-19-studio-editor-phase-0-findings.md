# Studio Editor — Phase 0 Spike Findings & Go/No-Go

- **Date:** 2026-06-21
- **Plan:** `docs/superpowers/plans/2026-06-19-studio-editor-phase-0-spike.md`
- **Branch:** `feat/studio-editor`
- **Verdict: GO** — proceed with Approach C (Rust-only renderer, live native preview surface) as specified.

## Decision

All three assumptions the architecture rests on are retired. Build Phase 1 on the
`render-core` foundation + the native-surface approach. No fallback needed.

## The three unknowns

### ✅ Unknown A — live native preview surface under the webview (RETIRED)
A wgpu/Metal surface renders **behind** a transparent region of the WKWebView and
aligns pixel-accurately to a React `<div>`. Verified visually on macOS:
- Surface renders (teal clear color) and **composites behind** the web UI — the web
  layer (border, text) draws on top, the desktop shows through the rest of the
  transparent window.
- **X and Y aligned** after the y-flip fix below.
- **Critical gotcha (the whole reason this needed a spike):** Tauri/wry uses a
  **full-size content view**, so `contentView.bounds` == `contentRectForFrameRect`
  == window `frame` (all 800pt in the test) — none of them reveal the title-bar
  inset. The WKWebView is placed in `contentLayoutRect` (the area *not* obscured by
  the title bar). The Y flip MUST use `contentLayoutRect`:
  ```
  contentLayoutRect = (0,0) 1200x772   // 800 − 28pt title bar
  webview_top = origin.y + height = 772
  appkit_y = webview_top − (y_pt + h_pt)   // bottom-left origin
  x_pt = origin.x + x/scale
  ```
- The editor preview must be a **fixed, non-scrolling** region (the native surface
  is positioned in window coords and does not follow document scroll). Enforced with
  `position: fixed; inset: 0; overflow: hidden` + a global margin/overflow reset.
- **Resize:** the spike re-invokes `spike_show_surface` on `window` resize and
  re-aligns; live-drag smoothness was not stress-tested (acceptable — GPUI will
  replace this scaffolding; see below).

### ✅ wgpu 29 headless on macOS Metal (RETIRED)
`Gpu::headless()` gets a Metal adapter with no window; offscreen render + 256-byte
row-aligned readback verified by golden pixel tests.

### ✅ Unknown B — Rust decode mp4 → RGBA (RETIRED, with a caveat)
`mp4` demux + `openh264` decode → RGBA verified on a committed fixture; channel
order **RGBA** confirmed via a rendered PNG.
- **Caveat — throughput not yet measured on a real recording.** The throughput test
  is `#[ignore]` and was not run against a real macroni recording (no sample wired).
  **Phase 1 must measure decode fps** on a real recording to decide the frame
  cursor/cache design.
- `decode_frame(i)` currently replays 0..=i (O(n²)) — fine for the spike, **needs a
  frame cursor/cache in Phase 1.**

## Verified API facts (feed directly into the Phase 1 plan)

**Resolved versions:** `wgpu = 29.0.3`, `objc2 = 0.6`, `objc2-app-kit/foundation/quartz-core = 0.3`, `openh264 = 0.6.6`, `mp4 = 0.14`.

**wgpu 29 deltas from older docs/sketches:**
- `Instance::request_adapter` → returns `Result` (not `Option`).
- `Adapter::request_device` → single `&DeviceDescriptor` arg (no trailing trace `Option`).
- `Instance::default()` — `InstanceDescriptor` is by-value and has **no** `Default`.
- `Surface::get_current_texture()` → returns a `CurrentSurfaceTexture` **enum**
  (`Success/Suboptimal/Timeout/Occluded/Outdated/Lost/Validation`), **not** `Result`.
- `SurfaceTargetUnsafe::CoreAnimationLayer(*mut c_void)` for a Metal layer (gated `#[cfg(metal)]`).
- `ImageCopyTexture/Buffer` → renamed `TexelCopyTextureInfo/TexelCopyBufferInfo`.
- `RenderPassColorAttachment.depth_slice: None`; `RenderPassDescriptor.multiview_mask: None`.
- `Device::poll(PollType::wait_indefinitely())` replaces `Maintain::Wait`.

**openh264 0.6.6:** `Decoder::new()`; `decode(&[u8]) -> Result<Option<DecodedYUV>>` (stateful, feed access units in order); `DecodedYUV::write_rgba8(&mut buf)`; dimensions via `YUVSource::dimensions()`.

**mp4 0.14:** `Mp4Reader::read_header(reader, size)`; SPS/PPS via `track.sequence_parameter_set()` / `picture_parameter_set()`; samples via `read_sample` are **AVCC** (4-byte length-prefixed) → convert to **Annex-B** (`00 00 00 01`) and prepend SPS/PPS to the first keyframe.

**macOS native-surface recipe (in `src-tauri/src/preview_surface.rs`, all on the main thread via `window.run_on_main_thread`):**
- `window.ns_window()` → `NSWindow`; `setOpaque(false)` + `setBackgroundColor(clearColor)`.
- Create `NSView` (`wantsLayer=true`) with a `CAMetalLayer`; `setContentsScale(backingScaleFactor)`, `setDrawableSize(physical px)`.
- Insert below the webview: `contentView.addSubview:positioned(Below):relativeTo(None)`.
- Y-flip against `contentLayoutRect` (see Unknown A).
- wgpu surface from the layer pointer via `CoreAnimationLayer`; dedicated adapter with `compatible_surface: Some(&surface)`.

**Boundary check correction:** the plan's `cargo tree -p render-core | grep -c tauri` is fooled by the `src-tauri/` path. Correct: `cargo tree -p render-core | tail -n +2 | grep -ci tauri` → `0` (verified).

**CI note:** the offscreen/golden wgpu tests need a GPU (Metal locally); GPU-less CI returns `NoAdapter` → mark those tests `#[ignore]` in CI or provision a software adapter.

## Tracked debt the Phase 1 `Engine` API must resolve (NOT inherit)
1. **Panic-in-library:** `render_solid` / `composite_frame_on_bg` / `read_target_rgba` return `Vec`/panic on GPU failure → make them `Result<_, GpuError>` (add `GpuError::Readback`).
2. **Decode O(n²) replay** → frame cursor/cache; measure real-recording throughput first.
3. **NAL truncation** silently dropped in `avcc_to_annexb` → surface a `DecodeError`.
4. **Composite test** asserts only bg+alpha → assert center-pixel color to lock channel order.
5. **`gpu.rs` ~480 lines** → likely split `Gpu`/context vs `Compositor` in Phase 1.

## What carries into Phase 1
- **Keep:** the whole `render-core` foundation (workspace, `Mp4FrameSource`/`RgbaFrame`, `Gpu` + offscreen render/readback, the compositor seed) — reviewed merge-ready.
- **Throwaway (delete/replace in Phase 1 or at GPUI migration):** the `studio` spike window, `StudioSpike.tsx`, `studio.html`/`studio.tsx`, and `preview_surface.rs` is *reference* — its `contentLayoutRect` recipe + objc2 calls graduate into the real preview integration, but the spike command/UI are disposable.
- The host-agnostic boundary held: all surface/objc2/window code is in the macroni crate; `render-core` has zero windowing code.

## Phase 1 (next) — Backgrounds & framing
Per design spec §8: `ProjectDoc` skeleton + the `Engine`/`FrameSource`/`Compositor`
interfaces (Result-returning) + background/padding/radius/shadow compositing, live
preview via the native surface, and export (render every frame → openh264 encode →
mp4 mux). Write the Phase 1 plan from the verified APIs above.
