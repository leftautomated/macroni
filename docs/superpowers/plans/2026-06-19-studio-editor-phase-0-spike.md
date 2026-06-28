# Studio Editor — Phase 0 (Spike) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retire the two assumptions the whole studio-editor architecture rests on — (A) a live wgpu/Metal preview surface rendered *under* a transparent region of macroni's WKWebView, aligned to a React `<div>`; and (B) Rust-side decode of a recorded `screen.mp4` into RGBA frames via `mp4` + `openh264`.

**Architecture:** A new host-agnostic `render-core` crate (no `tauri` dependency) holds decode + wgpu compositing. Tasks 1–4 produce *real, kept* foundation code (the crate, decode, offscreen render, golden-frame harness). Task 5 is the only genuinely throwaway/scaffolding part (the native-surface webview integration, which the future GPUI migration will replace). Task 6 records findings and a go/no-go.

**Tech Stack:** Rust, Cargo workspace, `wgpu = "29.0.3"`, `raw-window-handle = "0.6.2"`, `openh264 = "0.6"` (already in deps, supports decode), `mp4 = "0.14"` (already in deps), `bytemuck`, `pollster` (block on async wgpu init in tests), Tauri 2, `tauri-nspanel` (already in deps, gives AppKit/NSView access on macOS).

## Global Constraints

- **Platform:** macOS-first. Do not attempt Windows in this phase.
- **Crate boundary:** `render-core` MUST NOT depend on `tauri`. This is the load-bearing rule; violating it defeats the GPUI-migration design.
- **Spike discipline:** Tasks 1–4 are tested, kept code. Task 5 is throwaway — do not gold-plate; the only goal is a yes/no answer + the working API recipe recorded in Task 6.
- **No new media deps:** decode uses the already-linked `openh264` + `mp4`. Do not add ffmpeg.
- **Color:** scap captures BGRA; macroni's `encoder.rs` converts BGRA→I420 before H.264. Decode returns YUV; `DecodedYUV::write_rgba8` yields RGBA8. Track channel order explicitly (Task 6 records the verified order).

---

### Task 1: Cargo workspace + `render-core` crate skeleton

**Files:**
- Create: `render-core/Cargo.toml`
- Create: `render-core/src/lib.rs`
- Modify: `src-tauri/Cargo.toml` (convert to workspace member; add `render-core` path dep)
- Create: `Cargo.toml` (workspace root) — note: macroni's Cargo project root is `src-tauri/`; the workspace root goes there.

**Interfaces:**
- Produces: crate `render_core` with a placeholder `pub fn version() -> &'static str`.

- [ ] **Step 1: Create the workspace root manifest**

macroni's Rust project lives in `src-tauri/`. Make `src-tauri/Cargo.toml` a workspace. Add at the TOP of `src-tauri/Cargo.toml`:

```toml
[workspace]
members = [".", "render-core"]
resolver = "2"
```

- [ ] **Step 2: Create `render-core/Cargo.toml`**

```toml
[package]
name = "render-core"
version = "0.1.0"
edition = "2021"

[dependencies]
openh264 = { version = "0.6", default-features = false, features = ["source"] }
mp4 = "0.14"
wgpu = "29.0.3"
bytemuck = { version = "1", features = ["derive"] }
serde = { version = "1", features = ["derive"] }

[dev-dependencies]
pollster = "0.3"
```

> NOTE: confirm `wgpu = "29.0.3"` resolves with macroni's existing lockfile; if it conflicts, run `cargo update -p wgpu` and record the resolved version in Task 6.

- [ ] **Step 3: Create `render-core/src/lib.rs`**

```rust
//! Host-agnostic rendering core for the studio editor.
//! MUST NOT depend on `tauri`.

pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

#[cfg(test)]
mod tests {
    #[test]
    fn version_is_nonempty() {
        assert!(!super::version().is_empty());
    }
}
```

- [ ] **Step 4: Add `render-core` as a dependency of the macroni crate**

In `src-tauri/Cargo.toml` `[dependencies]`, add:

```toml
render-core = { path = "render-core" }
```

- [ ] **Step 5: Build the workspace**

Run: `cd src-tauri && cargo build`
Expected: both `render-core` and `macroni` compile. No `tauri` in `render-core`'s dependency tree.

- [ ] **Step 6: Verify the boundary**

Run: `cd src-tauri && cargo tree -p render-core | tail -n +2 | grep -ci tauri`
Expected: `0`

> NOTE: drop the root line with `tail -n +2` — a bare `grep tauri` matches the
> `src-tauri/` directory in the crate's own path and reports a false `1`.

- [ ] **Step 7: Run the placeholder test**

Run: `cd src-tauri && cargo test -p render-core`
Expected: `version_is_nonempty` PASSES.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/Cargo.toml render-core/
git commit -m "feat(render-core): scaffold host-agnostic crate + cargo workspace"
```

---

### Task 2: Decode `screen.mp4` → RGBA frames (Unknown B)

**Files:**
- Create: `render-core/src/decode.rs`
- Create: `render-core/tests/fixtures/gen_fixture.rs` (test-only helper that synthesizes a fixture mp4)
- Create: `render-core/tests/fixtures/solid.mp4` (generated, committed)
- Modify: `render-core/src/lib.rs` (add `pub mod decode;`)

**Interfaces:**
- Produces:
  - `pub struct Mp4FrameSource` with `pub fn open(path: &std::path::Path) -> Result<Self, DecodeError>`
  - `impl Mp4FrameSource { pub fn dimensions(&self) -> (u32, u32); pub fn frame_count(&self) -> usize; pub fn decode_frame(&mut self, index: usize) -> Result<RgbaFrame, DecodeError>; }`
  - `pub struct RgbaFrame { pub width: u32, pub height: u32, pub data: Vec<u8> }` (RGBA8, row-major, `width*height*4` bytes)
  - `pub enum DecodeError { Io(...), Demux(...), Codec(...), NoFrame }`

- [ ] **Step 1: Generate a committed fixture mp4**

The decode test needs a tiny, deterministic H.264/MP4 input. Generate one by mirroring macroni's existing encode path (`src-tauri/src/encoder.rs`) — encode 3 solid-color BGRA frames at 64×48 to `render-core/tests/fixtures/solid.mp4`. Write this as an `#[ignore]` test so it is run once by hand, then commit the output.

```rust
// render-core/tests/fixtures/gen_fixture.rs  (run with: cargo test -p render-core --test gen_fixture -- --ignored)
// Encodes 3 solid frames (red, green, blue) 64x48 -> tests/fixtures/solid.mp4
// Mirror the openh264 EncoderConfig + mp4 muxing already used in src-tauri/src/encoder.rs.
// (Implementer: copy the BGRA->I420 + openh264 encode + mp4 mux sequence from encoder.rs,
//  scaled to 64x48, 3 frames, 30fps. Keep it minimal — this is fixture generation only.)
```

> The exact encode sequence is whatever `src-tauri/src/encoder.rs` already does to produce a valid macroni recording — reuse it verbatim, just smaller. This guarantees the fixture matches the real capture format we must decode.

Run: `cd src-tauri && cargo test -p render-core --test gen_fixture -- --ignored`
Expected: `render-core/tests/fixtures/solid.mp4` exists, non-empty.

- [ ] **Step 2: Write the failing decode test**

```rust
// render-core/tests/decode_test.rs
use render_core::decode::Mp4FrameSource;
use std::path::Path;

#[test]
fn decodes_fixture_dimensions_and_count() {
    let mut src = Mp4FrameSource::open(Path::new("tests/fixtures/solid.mp4")).unwrap();
    assert_eq!(src.dimensions(), (64, 48));
    assert_eq!(src.frame_count(), 3);
}

#[test]
fn first_frame_is_rgba_correct_size() {
    let mut src = Mp4FrameSource::open(Path::new("tests/fixtures/solid.mp4")).unwrap();
    let frame = src.decode_frame(0).unwrap();
    assert_eq!(frame.width, 64);
    assert_eq!(frame.height, 48);
    assert_eq!(frame.data.len(), 64 * 48 * 4);
}
```

- [ ] **Step 3: Run to verify failure**

Run: `cd src-tauri && cargo test -p render-core --test decode_test`
Expected: FAIL — `Mp4FrameSource` not found.

- [ ] **Step 4: Implement `decode.rs`**

Key sequence (concrete API, verified against openh264-0.6.6 + mp4-0.14):
1. `mp4::Mp4Reader::read_header(reader, size)` → find the video track (`TrackType::Video`).
2. Extract SPS/PPS from the track's `avc1` config (`track.trak.mdia.minf.stbl.stsd` AVC config), build an Annex-B header (`00 00 00 01` + SPS, `00 00 00 01` + PPS).
3. For each sample: `reader.read_sample(track_id, sample_id)` returns AVCC length-prefixed NALs. Convert to Annex-B (replace each 4-byte big-endian length with `00 00 00 01`). Prepend SPS/PPS to the first keyframe.
4. `openh264::decoder::Decoder::new()`; feed each Annex-B packet to `decoder.decode(&packet)`; on `Ok(Some(yuv))`, allocate `vec![0u8; w*h*4]` and call `yuv.write_rgba8(&mut buf)`.

```rust
use mp4::{Mp4Reader, TrackType};
use openh264::decoder::Decoder;
use std::io::BufReader;
use std::fs::File;

pub struct RgbaFrame { pub width: u32, pub height: u32, pub data: Vec<u8> }

#[derive(Debug)]
pub enum DecodeError { Io(std::io::Error), Demux(String), Codec(String), NoFrame }

pub struct Mp4FrameSource {
    decoder: Decoder,
    annexb_header: Vec<u8>,       // SPS+PPS as Annex-B
    samples_annexb: Vec<Vec<u8>>, // each access unit, Annex-B
    width: u32,
    height: u32,
}

impl Mp4FrameSource {
    pub fn open(path: &std::path::Path) -> Result<Self, DecodeError> {
        let f = File::open(path).map_err(DecodeError::Io)?;
        let size = f.metadata().map_err(DecodeError::Io)?.len();
        let reader = BufReader::new(f);
        let mp4 = Mp4Reader::read_header(reader, size).map_err(|e| DecodeError::Demux(e.to_string()))?;
        // ... locate video track, read width/height, SPS/PPS, and all samples as Annex-B ...
        // ... (implementer fills the AVCC->Annex-B conversion per Step-4 sequence) ...
        unimplemented!("fill per the 4-step sequence above; return populated struct")
    }
    pub fn dimensions(&self) -> (u32, u32) { (self.width, self.height) }
    pub fn frame_count(&self) -> usize { self.samples_annexb.len() }
    pub fn decode_frame(&mut self, index: usize) -> Result<RgbaFrame, DecodeError> {
        // Decoder is stateful: feed header (once) + samples up to `index`.
        // For the spike, decode sequentially from 0..=index (caching comes in Phase 1).
        unimplemented!("feed annexb_header + samples[0..=index]; on last, write_rgba8")
    }
}
```

> The `unimplemented!()` bodies are the implementer's work for *this task*, fully specified by the 4-step sequence and the cross-reference to `encoder.rs` (which already parses SPS/PPS on the encode side). They are not deferred to a later task.

- [ ] **Step 5: Run decode tests**

Run: `cd src-tauri && cargo test -p render-core --test decode_test`
Expected: both tests PASS.

- [ ] **Step 6: Measure decode throughput**

Add an `#[ignore]` benchmark-style test that opens a *real* macroni recording (path via env var `MACRONI_SAMPLE_MP4`) and times decoding 60 sequential frames; print frames/sec.

Run: `MACRONI_SAMPLE_MP4=<a real recording> cargo test -p render-core --test decode_test throughput -- --ignored --nocapture`
Expected: prints a frames/sec number. Record it in Task 6 (informs whether Phase 1 needs a frame cache).

- [ ] **Step 7: Commit**

```bash
git add render-core/src/decode.rs render-core/src/lib.rs render-core/tests/
git commit -m "feat(render-core): decode screen.mp4 to RGBA via mp4 + openh264"
```

---

### Task 3: wgpu offscreen render + pixel readback (golden-frame harness seed)

**Files:**
- Create: `render-core/src/gpu.rs`
- Modify: `render-core/src/lib.rs` (add `pub mod gpu;`)
- Create: `render-core/tests/offscreen_test.rs`

**Interfaces:**
- Produces:
  - `pub struct Gpu { pub device: wgpu::Device, pub queue: wgpu::Queue }`
  - `pub fn Gpu::headless() -> Result<Gpu, GpuError>` (picks any adapter; works with software fallback in CI)
  - `pub fn render_solid(gpu: &Gpu, w: u32, h: u32, rgba: [u8;4]) -> Vec<u8>` — renders a clear-color to an offscreen texture and reads it back as RGBA8 (`w*h*4` bytes). This proves the offscreen render→readback path that golden-frame tests and export both rely on.

- [ ] **Step 1: Write the failing offscreen test**

```rust
// render-core/tests/offscreen_test.rs
use render_core::gpu::{Gpu, render_solid};

#[test]
fn offscreen_clear_color_reads_back() {
    let gpu = Gpu::headless().expect("no gpu adapter");
    let out = render_solid(&gpu, 4, 4, [10, 20, 30, 255]);
    assert_eq!(out.len(), 4 * 4 * 4);
    // top-left pixel matches clear color (allow small tolerance for format conversion)
    assert!((out[0] as i32 - 10).abs() <= 2);
    assert!((out[1] as i32 - 20).abs() <= 2);
    assert!((out[2] as i32 - 30).abs() <= 2);
    assert_eq!(out[3], 255);
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd src-tauri && cargo test -p render-core --test offscreen_test`
Expected: FAIL — `gpu` module not found.

- [ ] **Step 3: Implement `gpu.rs`**

Concrete wgpu 29 offscreen pattern: request adapter (`power_preference: default`, no surface), create device/queue, create an `Rgba8UnormSrgb` (or `Rgba8Unorm`) texture with `RENDER_ATTACHMENT | COPY_SRC`, a render pass that clears to the color, copy texture → buffer (respect 256-byte row alignment), `map_async` + `device.poll(Wait)`, read bytes, un-pad rows.

```rust
use wgpu::util::DeviceExt; // if needed

pub struct Gpu { pub device: wgpu::Device, pub queue: wgpu::Queue }
#[derive(Debug)] pub enum GpuError { NoAdapter, Device(String) }

impl Gpu {
    pub fn headless() -> Result<Gpu, GpuError> {
        pollster::block_on(async {
            let instance = wgpu::Instance::default();
            let adapter = instance.request_adapter(&wgpu::RequestAdapterOptions::default())
                .await.ok_or(GpuError::NoAdapter)?;
            let (device, queue) = adapter.request_device(&wgpu::DeviceDescriptor::default(), None)
                .await.map_err(|e| GpuError::Device(e.to_string()))?;
            Ok(Gpu { device, queue })
        })
    }
}

pub fn render_solid(gpu: &Gpu, w: u32, h: u32, rgba: [u8;4]) -> Vec<u8> {
    // 1. create target texture (RENDER_ATTACHMENT|COPY_SRC), view
    // 2. encoder.begin_render_pass with LoadOp::Clear(color from rgba, normalized)
    // 3. create readback buffer with padded bytes_per_row (align_to 256)
    // 4. copy_texture_to_buffer; submit
    // 5. map_async + device.poll(Wait); copy out un-padded rows -> Vec<u8>
    unimplemented!("standard wgpu offscreen render+readback per the 5 steps above")
}
```

> Verify the wgpu 29 `request_adapter`/`request_device` signatures (they shifted across versions); adjust `.await`/`Option` vs `Result` as the compiler dictates. Record the exact working signatures in Task 6.

- [ ] **Step 4: Run the offscreen test**

Run: `cd src-tauri && cargo test -p render-core --test offscreen_test`
Expected: PASS. (If CI has no GPU, confirm a software adapter is selected; otherwise mark `#[ignore]` in CI and record in Task 6.)

- [ ] **Step 5: Commit**

```bash
git add render-core/src/gpu.rs render-core/src/lib.rs render-core/tests/offscreen_test.rs
git commit -m "feat(render-core): wgpu offscreen render + pixel readback"
```

---

### Task 4: Composite a decoded frame on a background (offscreen → PNG)

**Files:**
- Modify: `render-core/src/gpu.rs` (add textured-quad compositing)
- Create: `render-core/tests/composite_test.rs`
- Add dev-dep: `image = "0.25"` in `render-core/Cargo.toml` (test-only, for PNG write/inspection)

**Interfaces:**
- Produces: `pub fn composite_frame_on_bg(gpu: &Gpu, frame: &RgbaFrame, bg: [u8;4], out_w: u32, out_h: u32) -> Vec<u8>` — uploads `frame` as a texture, draws it centered over a `bg` clear color into an `out_w*out_h` target, returns RGBA8. (This is the seed of the real compositor.)

- [ ] **Step 1: Write the failing composite test**

```rust
// render-core/tests/composite_test.rs
use render_core::decode::Mp4FrameSource;
use render_core::gpu::{Gpu, composite_frame_on_bg};
use std::path::Path;

#[test]
fn composites_frame_centered_on_bg() {
    let gpu = Gpu::headless().unwrap();
    let mut src = Mp4FrameSource::open(Path::new("tests/fixtures/solid.mp4")).unwrap();
    let frame = src.decode_frame(0).unwrap(); // 64x48
    let out = composite_frame_on_bg(&gpu, &frame, [0, 0, 0, 255], 128, 96); // 2x canvas, black bg
    assert_eq!(out.len(), 128 * 96 * 4);
    // a corner pixel should be background (black), center should be the frame's color
    let corner = &out[0..4];
    assert_eq!(corner, &[0, 0, 0, 255]);
    let center_idx = ((48 * 128) + 64) * 4; // roughly center
    assert!(out[center_idx + 3] == 255); // opaque frame pixel
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd src-tauri && cargo test -p render-core --test composite_test`
Expected: FAIL — `composite_frame_on_bg` not found.

- [ ] **Step 3: Implement textured-quad compositing in `gpu.rs`**

Minimal pipeline: a WGSL shader drawing a full-quad sampled texture; upload `frame.data` to an `Rgba8Unorm` texture; vertex buffer for a centered quad sized `frame_w/out_w` × `frame_h/out_h` in NDC; clear to `bg`; draw; read back (reuse Task 3's readback).

```wgsl
// render-core/src/shaders/quad.wgsl
@group(0) @binding(0) var tex: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
struct VsOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };
@vertex fn vs(@location(0) p: vec2<f32>, @location(1) uv: vec2<f32>) -> VsOut {
  return VsOut(vec4<f32>(p, 0.0, 1.0), uv);
}
@fragment fn fs(in: VsOut) -> @location(0) vec4<f32> { return textureSample(tex, samp, in.uv); }
```

- [ ] **Step 4: Run the composite test**

Run: `cd src-tauri && cargo test -p render-core --test composite_test`
Expected: PASS.

- [ ] **Step 5: Manually eyeball the output**

Add an `#[ignore]` test that writes the composite to `target/composite_preview.png` via the `image` crate; open it and confirm the frame sits centered on the background with correct colors (validates the BGRA/RGBA channel order end-to-end).

Run: `cargo test -p render-core --test composite_test write_png -- --ignored && open src-tauri/target/composite_preview.png`
Expected: visually correct. Record the verified channel order in Task 6.

- [ ] **Step 6: Commit**

```bash
git add render-core/src/gpu.rs render-core/src/shaders/ render-core/tests/composite_test.rs render-core/Cargo.toml
git commit -m "feat(render-core): composite decoded frame over background (compositor seed)"
```

---

### Task 5: Live native preview surface under the webview (Unknown A — throwaway)

**Files:**
- Create: `src-tauri/src/preview_surface.rs` (macOS-only; `#[cfg(target_os = "macos")]`)
- Modify: `src-tauri/src/lib.rs` (register a `spike_show_surface` command + module)
- Modify: `src/App.tsx` (temporary: a transparent `<div id="preview-hole">` + a button to invoke the spike command)

**Interfaces:**
- Produces (throwaway): a Tauri command `spike_show_surface(x, y, w, h)` that creates/repositions a wgpu surface behind a transparent webview region and renders the Task-4 composite into it.

> This task is THROWAWAY discovery. The goal is a yes/no answer and a recorded API recipe — not clean code. Do NOT write unit tests for it. Verification is manual (eyeball).

- [ ] **Step 1: Make the webview window background transparent**

In `src-tauri/tauri.conf.json`, ensure the studio window has `"transparent": true` (macroni already uses `macos-private-api`). In React, give `#preview-hole` `background: transparent` and a fixed size/position so we can see through to the native layer.

- [ ] **Step 2: Obtain the NSView + attach a CAMetalLayer**

From the Tauri window, get the `RawWindowHandle` (`AppKitWindowHandle`) via `raw-window-handle = "0.6.2"`. The macroni window already exposes AppKit internals through `tauri-nspanel`. Create a child `NSView` (or sublayer) with a `CAMetalLayer`, inserted BELOW the WKWebView in the view hierarchy so the transparent hole reveals it.

```rust
// preview_surface.rs (sketch — discover exact objc2/cocoa calls during the spike)
// 1. let handle = window.window_handle()?.as_raw();  // AppKitWindowHandle { ns_view }
// 2. create CAMetalLayer, set frame = (x,y,w,h), insert as sublayer below webview
// 3. let surface = unsafe { wgpu_instance.create_surface_unsafe(
//        SurfaceTargetUnsafe::from_window(&metal_layer_handle)?) };
// 4. configure surface (Rgba8Unorm/Bgra8Unorm, w, h), render Task-4 composite, present
```

- [ ] **Step 3: Wire the spike command**

`spike_show_surface(x,y,w,h)` creates/repositions the layer + surface and renders one composited frame from a real recording.

- [ ] **Step 4: Manual verification — static alignment**

Run: `cd src-tauri && cargo tauri dev`
Click the spike button. Expected: the composited frame appears exactly within the `#preview-hole` div bounds (not behind the rest of the UI).

- [ ] **Step 5: Manual verification — resize alignment**

Resize the window. Re-invoke (or hook a resize listener that calls `spike_show_surface` with new bounds). Expected: the surface stays aligned to the div. Record how robust this is (does it lag/tear on resize?) in Task 6.

- [ ] **Step 6: Commit the spike (kept for reference until Phase 1 supersedes it)**

```bash
git add src-tauri/src/preview_surface.rs src-tauri/src/lib.rs src/App.tsx src-tauri/tauri.conf.json
git commit -m "spike(studio): native wgpu/Metal preview surface under transparent webview"
```

---

### Task 6: Findings + go/no-go writeup

**Files:**
- Create: `docs/superpowers/specs/2026-06-19-studio-editor-phase-0-findings.md`

- [ ] **Step 1: Record findings**

Write the findings doc covering, with concrete values:
- **Unknown A verdict:** does the native surface align reliably under the transparent webview? On resize? Go / fallback-to-canvas-streaming.
- **Unknown B verdict:** decode works? measured frames/sec on a real recording; does Phase 1 need a frame cache or proxy resolution?
- **Verified APIs (copy exact signatures):** `wgpu 29` adapter/device request, `create_surface_unsafe` target construction, `openh264` decode loop, `mp4` sample extraction + AVCC→Annex-B conversion.
- **Verified color order:** BGRA vs RGBA at each hop (scap → mp4 → openh264 → wgpu).
- **CI note:** does the offscreen wgpu test run without a GPU (software adapter), or must it be `#[ignore]` in CI?
- **Resolved wgpu version** (if changed from 29.0.3).

- [ ] **Step 2: Decide go/no-go for Phase 1**

State plainly: proceed with Approach C (Rust-only, live native surface) as specified, OR adopt the canvas-streaming preview fallback (render-core unchanged either way). This decision unblocks writing the Phase 1 plan.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-06-19-studio-editor-phase-0-findings.md
git commit -m "docs(studio): Phase 0 spike findings + go/no-go"
```

---

## Self-Review

**1. Spec coverage (vs §7 of the design spike acceptance criteria):**
- "Colored wgpu surface behind transparent hole, aligned across resize" → Task 5 (Steps 4–5). ✓
- "Decode screen.mp4 + composite one frame onto the surface" → Tasks 2 + 4 (offscreen) + Task 5 (on-surface). ✓
- "Measure decode throughput" → Task 2 Step 6, recorded in Task 6. ✓
- Crate boundary (no tauri in render-core) → Task 1 Step 6. ✓

**2. Placeholder scan:** The `unimplemented!()` bodies in Tasks 2–3 are each fully specified by an explicit numbered sequence in the same step (not deferred work); acceptable. Task 5's "sketch" is intentionally discovery — it is the only throwaway task and is labeled as such. No "TBD/add error handling/write tests for the above" placeholders.

**3. Type consistency:** `RgbaFrame` defined in Task 2 is consumed unchanged in Task 4. `Gpu` defined in Task 3 is consumed in Task 4. `Mp4FrameSource::decode_frame` signature is identical across Tasks 2 and 4 tests. ✓

---

## Notes for the Phase 1 plan (written after this spike)

Tasks 2–4 are NOT throwaway — they become the foundation of `render-core`'s compositor and `FrameSource`. Phase 1 will: promote `composite_frame_on_bg` into a `Compositor` driven by `ProjectDoc.framing` (padding/radius/shadow/background-gradient/wallpaper), add the `Engine`/`FrameSource`/`RenderTarget` interfaces from spec §4, implement export (offscreen render every frame → openh264 encode → mp4 mux), and build the React editor panel. The exact APIs verified in Task 6 feed directly into that plan's concrete code.
</content>
