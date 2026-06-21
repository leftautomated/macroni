# Studio Editor — Phase 1 (Backgrounds & Framing) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the proven Phase 0 pieces into a working end-to-end framing pipeline: open a recording in a studio editor, put the video on a chosen background with padding / rounded corners / drop shadow, see it live, and export a finished MP4 — driven entirely by a serializable `ProjectDoc`.

**Architecture:** A `ProjectDoc` (serde) is the single source of truth. `render-core` gains an `Engine` that ties a `FrameSource` (decoded frames) to a `Compositor` (wgpu scene: background → framed video) and exposes ONE render path used by both live preview (`render_to_surface`) and export (`export`) — so preview == export, no drift. The macroni crate hosts the native preview surface, project persistence, and a React editor. render-core stays windowing-free (host-agnostic, GPUI-ready).

**Tech Stack:** Rust, wgpu 29.0.3, openh264 0.6, mp4 0.14, serde, bytemuck; React + Vite; Tauri 2 (macOS).

## Global Constraints

- **Platform:** macOS-first.
- **Boundary:** `render-core` MUST NOT depend on `tauri`. Verify: `cargo tree -p render-core | tail -n +2 | grep -ci tauri` == `0` (the bare `grep tauri` is fooled by the `src-tauri/` path).
- **No new media deps:** decode/encode use the already-linked `openh264` + `mp4`. No ffmpeg.
- **Single renderer:** preview and export walk the SAME `Compositor`. No second render implementation.
- **Result-returning GPU API:** all `render-core` GPU entry points return `Result<_, EngineError>` / `Result<_, GpuError>` — NO panic-in-library (resolves Phase 0 tracked debt).
- **Persistence:** a project is stored as a sibling `<recording_id>.project.json` next to the recording (NOT inline in recordings.json).
- **Phase 1 renders ONLY framing.** `ProjectDoc` carries zoom/cursor/webcam/trim/speed/crop fields, but they are inert this phase (parse + round-trip, not rendered).
- **Verification backbone:** every compositor feature gets a **golden-frame test** — render a known doc offscreen, read back pixels, assert specific pixels. Golden tests run headless on Metal; on GPU-less CI they are `#[ignore]` (per Phase 0 findings).
- **Verified APIs:** see `docs/superpowers/specs/2026-06-19-studio-editor-phase-0-findings.md` (wgpu 29: `get_current_texture()`→`CurrentSurfaceTexture` enum, `Instance::default()`, `SurfaceTargetUnsafe::CoreAnimationLayer`, `TexelCopy*`, `PollType::wait_indefinitely`; openh264 `Decoder`/`write_rgba8`; mp4 AVCC→Annex-B; native surface y-flip via `contentLayoutRect`).

## File structure

render-core (`src-tauri/render-core/src/`):
- `doc.rs` (NEW) — `ProjectDoc` + sub-types, serde.
- `decode.rs` (MODIFY) — add `FrameSource` trait + forward-cursor cache.
- `gpu.rs` (MODIFY) — Result-ify; expose `Gpu` + readback helper reused by compositor.
- `compositor.rs` (NEW) — `Compositor`: background + framed video (padding/radius/shadow).
- `engine.rs` (NEW) — `Engine`: FrameSource + Compositor; `render_to_texture` (offscreen), `render_to_surface` (host preview), `export`.
- `encode.rs` (NEW) — openh264 encode + mp4 mux (pure; mirrors capture `encoder.rs` logic, no tauri).
- `shaders/` (NEW) — `background.wgsl`, `framed_video.wgsl`.

macroni (`src-tauri/src/`):
- `project_store.rs` (NEW) — load/save `<id>.project.json`; default doc from a recording.
- `preview_surface.rs` (MODIFY) — hold an `Engine`; render composited frames to the surface; new studio commands.
- `lib.rs` (MODIFY) — register commands.

Frontend (`src/`):
- `windows/studio.tsx` (MODIFY) — real editor entry (replaces spike bootstrap).
- `components/studio/StudioEditor.tsx` (NEW) — layout + preview hole + panels.
- `components/studio/BackgroundPicker.tsx`, `FramingControls.tsx`, `ExportButton.tsx` (NEW).
- `components/studio/StudioSpike.tsx` (DELETE at Task 12).
- `hooks/useProjectDoc.ts` (NEW) — doc state + debounced `studio_render_preview`.
- `types/project.ts` (NEW) — TS mirror of `ProjectDoc`.

---

### Task 1: `ProjectDoc` data model + serde (render-core)

**Files:**
- Create: `src-tauri/render-core/src/doc.rs`
- Modify: `src-tauri/render-core/src/lib.rs` (add `pub mod doc;`)
- Test: in `doc.rs` `#[cfg(test)]`

**Interfaces:**
- Produces (all `#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]`):
  - `Rgba([u8; 4])` newtype (serde as `[u8;4]`).
  - `Background` enum (serde tagged `{"type":"solid","color":[..]}` etc.): `Solid(Rgba)`, `LinearGradient { from: Rgba, to: Rgba, angle_deg: f32 }`, `Wallpaper { path: String }`.
  - `Shadow { blur_px: f32, offset_y_px: f32, opacity: f32 }`.
  - `Framing { background: Background, padding_px: f32, border_radius_px: f32, shadow: Shadow }`.
  - Inert sub-types (defaulted, not rendered this phase): `ZoomRegion { id: String, start_ms: u64, end_ms: u64, scale: f32, focus_cx: f32, focus_cy: f32, source: ZoomSource }`, `ZoomSource { Auto, Manual }`, `TrimRegion { id, start_ms, end_ms }`, `SpeedRegion { id, start_ms, end_ms, speed: f32 }`.
  - `Media { screen_mp4: String, webcam_mp4: Option<String>, cursor_json: Option<String> }`.
  - `ProjectDoc { version: u32, media: Media, framing: Framing, zoom_regions: Vec<ZoomRegion>, trim_regions: Vec<TrimRegion>, speed_regions: Vec<SpeedRegion> }` with `version = 1`.
  - `impl ProjectDoc { pub fn new_default(screen_mp4: String) -> Self }` (sensible defaults: solid dark-gray bg, padding 64.0, radius 12.0, shadow blur 32/offset 16/opacity 0.35, empty region vecs).

- [ ] **Step 1: Write the failing serde round-trip test**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn doc_round_trips_through_json() {
        let doc = ProjectDoc::new_default("rec1.mp4".into());
        let json = serde_json::to_string(&doc).unwrap();
        let back: ProjectDoc = serde_json::from_str(&json).unwrap();
        assert_eq!(doc, back);
        assert_eq!(back.version, 1);
        assert_eq!(back.media.screen_mp4, "rec1.mp4");
    }
    #[test]
    fn background_variants_round_trip() {
        for bg in [
            Background::Solid(Rgba([10, 20, 30, 255])),
            Background::LinearGradient { from: Rgba([0,0,0,255]), to: Rgba([255,255,255,255]), angle_deg: 45.0 },
            Background::Wallpaper { path: "w.jpg".into() },
        ] {
            let s = serde_json::to_string(&bg).unwrap();
            assert_eq!(bg, serde_json::from_str::<Background>(&s).unwrap());
        }
    }
}
```

- [ ] **Step 2: Run, verify failure** — `cd src-tauri && cargo test -p render-core doc::` → FAIL (module missing).
- [ ] **Step 3: Implement `doc.rs`** with the types above. Use `#[serde(tag = "type", rename_all = "snake_case")]` on `Background`; `#[derive(...Serialize, Deserialize)]` on all. `Rgba` as `#[serde(transparent)]` newtype over `[u8;4]`.
- [ ] **Step 4: Run, verify pass** — `cargo test -p render-core doc::` → PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(render-core): ProjectDoc data model + serde"`

---

### Task 2: `FrameSource` trait + forward-cursor cache (render-core)

**Files:**
- Modify: `src-tauri/render-core/src/decode.rs`
- Test: `src-tauri/render-core/tests/decode_test.rs` (extend)

**Interfaces:**
- Consumes: `Mp4FrameSource`, `RgbaFrame`, `DecodeError` (Task 2 of Phase 0).
- Produces:
  - `pub trait FrameSource { fn dimensions(&self) -> (u32, u32); fn frame_count(&self) -> usize; fn frame(&mut self, index: usize) -> Result<RgbaFrame, DecodeError>; }`
  - `impl FrameSource for Mp4FrameSource` — with a **forward cursor**: cache the decoder + the index it last produced. If `index == last+1`, decode just the next access unit (O(1) amortized for sequential export). If `index <= last` or a gap, reset the decoder and decode forward to `index`. Keep the public `decode_frame` as a thin wrapper over `frame` for back-compat.

- [ ] **Step 1: Write the failing forward-cursor test**

```rust
#[test]
fn sequential_access_does_not_replay_from_zero() {
    let mut src = Mp4FrameSource::open(Path::new("tests/fixtures/solid.mp4")).unwrap();
    // Decode all frames in order via the trait; each must return the right frame.
    let n = render_core::decode::FrameSource::frame_count(&src);
    for i in 0..n {
        let f = render_core::decode::FrameSource::frame(&mut src, i).unwrap();
        assert_eq!((f.width, f.height), (64, 48));
    }
    // Random-access backwards still works (resets internally).
    let f0 = render_core::decode::FrameSource::frame(&mut src, 0).unwrap();
    assert_eq!((f0.width, f0.height), (64, 48));
}
```

- [ ] **Step 2: Run, verify failure** — `cargo test -p render-core --test decode_test sequential` → FAIL (trait missing).
- [ ] **Step 3: Implement** the `FrameSource` trait + forward-cursor cache in `decode.rs`. Store `decoder: Decoder`, `cursor: Option<usize>` (last produced index). On `frame(i)`: if `cursor` is `Some(c)` and `i == c+1`, feed only `samples_annexb[i]`; else recreate the decoder, feed header + samples `0..=i`. Update `cursor = Some(i)`. (The header/sample storage already exists from Phase 0.)
- [ ] **Step 4: Run, verify pass** — `cargo test -p render-core --test decode_test` → all PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(render-core): FrameSource trait + forward-cursor decode cache"`

---

### Task 3: Result-ify the GPU API (render-core)

**Files:**
- Modify: `src-tauri/render-core/src/gpu.rs`
- Test: `tests/offscreen_test.rs`, `tests/composite_test.rs` (update call sites)

**Interfaces:**
- Produces: `GpuError` gains `Readback(String)` and `Surface(String)` variants. `render_solid(...) -> Result<Vec<u8>, GpuError>`, `composite_frame_on_bg(...) -> Result<Vec<u8>, GpuError>`, and the private `read_target_rgba(...) -> Result<Vec<u8>, GpuError>`. No `.expect()` / `panic!` remain in `gpu.rs` for recoverable GPU/poll/mapping failures — map them to `GpuError`.

- [ ] **Step 1: Update the existing tests to expect `Result`**

In `tests/offscreen_test.rs`: `let out = render_solid(&gpu, 4, 4, [10,20,30,255]).unwrap();`
In `tests/composite_test.rs`: `let out = composite_frame_on_bg(&gpu, &frame, [0,0,0,255], 128, 96).unwrap();`

- [ ] **Step 2: Run, verify failure** — `cargo test -p render-core` → FAIL (type mismatch: `Vec` vs `Result`).
- [ ] **Step 3: Implement** — change signatures to `Result`, replace each `.expect("...")` in `read_target_rgba`/poll/map with `.map_err(|e| GpuError::Readback(e.to_string()))?` (or a sentinel string for the channel case). Propagate `?` up through `render_solid`/`composite_frame_on_bg`.
- [ ] **Step 4: Run, verify pass** — `cargo test -p render-core` → PASS. Confirm `! grep -nE '\.expect\(|panic!|unwrap\(\)' src/gpu.rs` shows no recoverable-path panics (test code/`headless()` adapter-not-found may still return `GpuError`).
- [ ] **Step 5: Commit** — `git commit -am "refactor(render-core): GPU API returns Result, no panic-in-library"`

---

### Task 4: Compositor — background fill (solid + linear gradient)

**Files:**
- Create: `src-tauri/render-core/src/compositor.rs`, `src-tauri/render-core/src/shaders/background.wgsl`
- Modify: `src-tauri/render-core/src/lib.rs` (`pub mod compositor;`)
- Test: `src-tauri/render-core/tests/compositor_test.rs`

**Interfaces:**
- Consumes: `Gpu` (Task 3), `doc::{Background, Rgba}` (Task 1).
- Produces:
  - `pub struct Compositor { /* pipelines, sampler, etc. */ }`
  - `Compositor::new(gpu: &Gpu) -> Result<Compositor, GpuError>`
  - `Compositor::render_background(&self, gpu: &Gpu, bg: &Background, out_w: u32, out_h: u32) -> Result<wgpu::Texture, GpuError>` — returns an `out_w×out_h` `Rgba8Unorm` texture (`RENDER_ATTACHMENT|COPY_SRC|TEXTURE_BINDING`) filled per `bg`. (Wallpaper handled in a later step; for now `Wallpaper` falls back to a solid mid-gray — leave a `// TODO(Task 8): wallpaper` and render solid gray.)
  - A test helper `Compositor::read_texture(&self, gpu, &texture) -> Result<Vec<u8>, GpuError>` (reuse `gpu::read_target_rgba`).

**Golden assertions** (the spec for the shader):
- Solid `[200,50,50,255]`: every sampled pixel ≈ that color (±2).
- Linear gradient `from=[0,0,0]` `to=[255,255,255]` `angle_deg=0` (left→right): left-column pixel darker than right-column pixel; mid ≈ 128 (±20).

- [ ] **Step 1: Write the failing golden test**

```rust
use render_core::gpu::Gpu;
use render_core::compositor::Compositor;
use render_core::doc::{Background, Rgba};

fn px(buf: &[u8], w: u32, x: u32, y: u32) -> [u8;4] {
    let i = ((y*w + x) * 4) as usize; [buf[i],buf[i+1],buf[i+2],buf[i+3]]
}

#[test]
fn solid_background_fills() {
    let gpu = Gpu::headless().unwrap();
    let c = Compositor::new(&gpu).unwrap();
    let tex = c.render_background(&gpu, &Background::Solid(Rgba([200,50,50,255])), 32, 16).unwrap();
    let buf = c.read_texture(&gpu, &tex).unwrap();
    let p = px(&buf, 32, 16, 8);
    assert!((p[0] as i32-200).abs()<=2 && (p[1] as i32-50).abs()<=2 && (p[2] as i32-50).abs()<=2);
}

#[test]
fn horizontal_gradient_goes_dark_to_light() {
    let gpu = Gpu::headless().unwrap();
    let c = Compositor::new(&gpu).unwrap();
    let bg = Background::LinearGradient { from: Rgba([0,0,0,255]), to: Rgba([255,255,255,255]), angle_deg: 0.0 };
    let tex = c.render_background(&gpu, &bg, 64, 8).unwrap();
    let buf = c.read_texture(&gpu, &tex).unwrap();
    let left = px(&buf, 64, 1, 4)[0] as i32;
    let right = px(&buf, 64, 62, 4)[0] as i32;
    assert!(right - left > 150, "expected strong L→R ramp, got {left}->{right}");
}
```

- [ ] **Step 2: Run, verify failure** — `cargo test -p render-core --test compositor_test` → FAIL (module missing).
- [ ] **Step 3: Implement** `compositor.rs` + `background.wgsl`. Starter fragment shader (full-screen triangle; uniform `mode`, `color0`, `color1`, `angle`, `resolution`):

```wgsl
// background.wgsl — full-screen background fill.
struct Bg { color0: vec4<f32>, color1: vec4<f32>, params: vec4<f32> }; // params.x=mode(0 solid,1 grad), params.y=angle_rad
@group(0) @binding(0) var<uniform> bg: Bg;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  // full-screen triangle
  let p = array(vec2(-1.0,-1.0), vec2(3.0,-1.0), vec2(-1.0,3.0));
  return vec4<f32>(p[i], 0.0, 1.0);
}
@fragment fn fs(@builtin(position) frag: vec4<f32>) -> @location(0) vec4<f32> {
  if (bg.params.x < 0.5) { return bg.color0; }
  let dir = vec2<f32>(cos(bg.params.y), sin(bg.params.y));
  let res = bg.params.zw;
  let t = clamp(dot(frag.xy / res, dir), 0.0, 1.0); // frag.xy is in pixels; res = (w,h)
  return mix(bg.color0, bg.color1, t);
}
```

Iterate the shader until both golden tests pass (the gradient direction math is the likely tweak point — `frag.xy` origin/orientation). Convert `Rgba` `[u8;4]` → normalized `vec4<f32>` (divide by 255) when filling the uniform.

- [ ] **Step 4: Run, verify pass** — `cargo test -p render-core --test compositor_test` → PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(render-core): compositor background fill (solid + gradient)"`

---

### Task 5: Compositor — framed video (padding, centered fit)

**Files:**
- Modify: `src-tauri/render-core/src/compositor.rs`, create `src-tauri/render-core/src/shaders/framed_video.wgsl`
- Test: `tests/compositor_test.rs` (extend)

**Interfaces:**
- Produces: `Compositor::render_frame(&self, gpu: &Gpu, framing: &doc::Framing, video: &RgbaFrame, out_w: u32, out_h: u32) -> Result<Vec<u8>, GpuError>` — renders the background, then the `video` texture inset by `framing.padding_px` on every side, **aspect-fit** within the inset rect, centered. Returns RGBA8 (`out_w*out_h*4`). (Rounded corners + shadow are added in Tasks 6–7; for now draw a plain rect, no corner mask, no shadow — but DO honor padding + aspect-fit.)

**Golden assertions:**
- `out 200×120`, `padding 20`, video `64×48` solid red on solid-blue bg: a pixel at `(2,2)` (corner, inside padding) is blue; the center pixel is red; a pixel at `(10,60)` (within the 20px left padding band) is blue.

- [ ] **Step 1: Write the failing framed-video golden test**

```rust
#[test]
fn padding_insets_video_over_background() {
    let gpu = Gpu::headless().unwrap();
    let c = Compositor::new(&gpu).unwrap();
    let framing = render_core::doc::Framing {
        background: Background::Solid(Rgba([0,0,255,255])),
        padding_px: 20.0, border_radius_px: 0.0,
        shadow: render_core::doc::Shadow { blur_px: 0.0, offset_y_px: 0.0, opacity: 0.0 },
    };
    let video = RgbaFrame { width: 64, height: 48, data: vec![255,0,0,255].repeat(64*48) }; // solid red
    let out = c.render_frame(&gpu, &framing, &video, 200, 120).unwrap();
    let p = |x:u32,y:u32| { let i=((y*200+x)*4) as usize; [out[i],out[i+1],out[i+2],out[i+3]] };
    assert_eq!(p(2,2)[2], 255);            // corner = blue bg
    assert_eq!(p(10,60)[2], 255);          // inside left padding = blue bg
    let center = p(100,60);                 // center = red video
    assert!(center[0] > 200 && center[2] < 60);
}
```

- [ ] **Step 2: Run, verify failure** — `cargo test -p render-core --test compositor_test padding` → FAIL.
- [ ] **Step 3: Implement** `render_frame`: render background into a target, upload `video` as a texture (`queue.write_texture`, `bytes_per_row = video.width*4`), compute the aspect-fit rect inside `[padding, out_w-padding] × [padding, out_h-padding]`, draw a textured quad at that rect (NDC), read back. `framed_video.wgsl` = textured quad (reuse the Phase 0 quad shader pattern). Compute the quad NDC coords from the fit rect.
- [ ] **Step 4: Run, verify pass** — `cargo test -p render-core --test compositor_test` → PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(render-core): compositor framed video with padding + aspect-fit"`

---

### Task 6: Compositor — rounded corners

**Files:**
- Modify: `src-tauri/render-core/src/shaders/framed_video.wgsl`, `compositor.rs`
- Test: `tests/compositor_test.rs` (extend)

**Interfaces:**
- Produces: `render_frame` now honors `framing.border_radius_px` — the video rect is masked to a rounded rectangle (pixels outside the corner radius show the background).

**Golden assertions:** `out 200×120`, padding 0, radius 30, video solid-red on solid-blue, `out=video size scaled to fill`: the extreme corner pixel `(1,1)` is **blue** (outside the rounded corner); the center is red. With radius 0 (Task 5 test) corners stay red — keep that test green.

- [ ] **Step 1: Write the failing rounded-corner test**

```rust
#[test]
fn rounded_corners_show_background_at_corner() {
    let gpu = Gpu::headless().unwrap();
    let c = Compositor::new(&gpu).unwrap();
    let framing = render_core::doc::Framing {
        background: Background::Solid(Rgba([0,0,255,255])),
        padding_px: 0.0, border_radius_px: 40.0,
        shadow: render_core::doc::Shadow { blur_px:0.0, offset_y_px:0.0, opacity:0.0 },
    };
    let video = RgbaFrame { width: 200, height: 120, data: vec![255,0,0,255].repeat(200*120) };
    let out = c.render_frame(&gpu, &framing, &video, 200, 120).unwrap();
    let p = |x:u32,y:u32| { let i=((y*200+x)*4) as usize; [out[i],out[i+1],out[i+2],out[i+3]] };
    assert_eq!(p(1,1)[2], 255, "corner should be background (blue) due to radius");
    let center = p(100,60);
    assert!(center[0] > 200 && center[2] < 60, "center should be red video");
}
```

- [ ] **Step 2: Run, verify failure** — `cargo test -p render-core --test compositor_test rounded` → FAIL (corner still red).
- [ ] **Step 3: Implement** a rounded-rect SDF in `framed_video.wgsl`. Pass the quad's pixel size + `radius_px` as a uniform; in the fragment shader compute the signed distance to a rounded box and discard / output bg-alpha (or use `discard`) outside it. Simplest: output the sampled video with `alpha = step(sdf<=0)`; rely on `ALPHA_BLENDING` over the already-drawn background. Reference SDF:

```wgsl
fn sd_round_box(p: vec2<f32>, b: vec2<f32>, r: f32) -> f32 {
  let q = abs(p) - b + vec2<f32>(r);
  return length(max(q, vec2<f32>(0.0))) + min(max(q.x, q.y), 0.0) - r;
}
// in fs: p = (uv-0.5)*size_px; if sd_round_box(p, size_px*0.5, radius_px) > 0.0 { discard; }
```

- [ ] **Step 4: Run, verify pass** — `cargo test -p render-core --test compositor_test` → PASS (both rounded + the Task 5 padding test).
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(render-core): rounded-corner video mask (SDF)"`

---

### Task 7: Compositor — drop shadow

**Files:**
- Modify: `compositor.rs` (+ a `shadow.wgsl` or reuse), `tests/compositor_test.rs`

**Interfaces:**
- Produces: `render_frame` draws a soft drop shadow behind the video rect per `framing.shadow` (a dark, blurred, offset rounded rect) BETWEEN the background and the video.

**Golden assertions:** `out 200×160`, padding 30, radius 0, shadow `{blur 16, offset_y 12, opacity 0.5}`, white bg, red video: a pixel just BELOW the video's bottom edge (in the shadow-offset band, still over background) is **darker** than the same-position pixel rendered with shadow opacity 0. Center stays red; far corner stays ≈white.

- [ ] **Step 1: Write the failing shadow test**

```rust
#[test]
fn drop_shadow_darkens_below_video() {
    let gpu = Gpu::headless().unwrap();
    let c = Compositor::new(&gpu).unwrap();
    let mk = |op: f32| render_core::doc::Framing {
        background: Background::Solid(Rgba([255,255,255,255])),
        padding_px: 30.0, border_radius_px: 0.0,
        shadow: render_core::doc::Shadow { blur_px: 16.0, offset_y_px: 12.0, opacity: op },
    };
    let video = RgbaFrame { width: 100, height: 60, data: vec![255,0,0,255].repeat(100*60) };
    let with = c.render_frame(&gpu, &mk(0.5), &video, 200, 160).unwrap();
    let without = c.render_frame(&gpu, &mk(0.0), &video, 200, 160).unwrap();
    // sample a point just below the video rect, within the shadow band
    let idx = ((120u32*200 + 100)*4) as usize; // x=100 (center col), y=120 (below video)
    assert!((with[idx] as i32) < (without[idx] as i32) - 20, "shadow should darken below the video");
}
```

- [ ] **Step 2: Run, verify failure** — `cargo test -p render-core --test compositor_test shadow` → FAIL.
- [ ] **Step 3: Implement** the shadow pass: draw a rounded rect matching the video rect, offset by `offset_y_px`, color black at `opacity`, blurred by `blur_px`. Simplest correct approach: a fragment pass over the whole target that adds shadow using the rounded-box SDF with a smoothstep falloff of width `blur_px` (no separate blur texture needed): `shadow_a = opacity * (1 - smoothstep(0, blur_px, sd_round_box(p - offset, half, radius)))`, blended over the background before the video draws. Tune until the golden passes.
- [ ] **Step 4: Run, verify pass** — `cargo test -p render-core --test compositor_test` → PASS (all compositor tests).
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(render-core): drop shadow behind framed video"`

---

### Task 8: Wallpaper backgrounds + `Engine` offscreen render

**Files:**
- Create: `src-tauri/render-core/src/engine.rs`
- Modify: `compositor.rs` (wallpaper loading), `lib.rs` (`pub mod engine;`), `Cargo.toml` (add `image = "0.25"` as a NORMAL dep — needed to decode wallpaper JPEG/PNG at runtime)
- Test: `src-tauri/render-core/tests/engine_test.rs`

**Interfaces:**
- Consumes: `FrameSource` (Task 2), `Compositor` (Tasks 4–7), `doc::ProjectDoc` (Task 1).
- Produces:
  - Wallpaper: `Background::Wallpaper { path }` loads the image via the `image` crate, uploads it as a texture, and draws it cover-fit as the background (replaces the Task-4 gray fallback).
  - `pub struct Engine { gpu: Gpu, compositor: Compositor, source: Box<dyn FrameSource> }`
  - `Engine::new(source: Box<dyn FrameSource>) -> Result<Engine, EngineError>`
  - `Engine::output_size(&self) -> (u32, u32)` (the source dimensions for Phase 1; framing renders at source resolution).
  - `Engine::render_to_texture(&mut self, doc: &ProjectDoc, frame_index: usize) -> Result<Vec<u8>, EngineError>` — decode `frame_index`, composite per `doc.framing`, return RGBA8.
  - `pub enum EngineError { Decode(DecodeError), Gpu(GpuError), Image(String) }` (+ `From` impls).

**Golden assertions:** open the `solid.mp4` fixture via `Mp4FrameSource`, `Engine::render_to_texture(default_doc, 0)` returns `out_w*out_h*4` bytes; with a solid background the padding band shows the bg color and the center shows the (decoded) frame.

- [ ] **Step 1: Write the failing engine test** (open fixture, render frame 0, assert size + that padding band == bg color, center != bg). Use `ProjectDoc::new_default` with `padding_px = 16.0`, solid bg `[0,0,255,255]`.
- [ ] **Step 2: Run, verify failure** — `cargo test -p render-core --test engine_test` → FAIL.
- [ ] **Step 3: Implement** `engine.rs` (wire FrameSource + Compositor) and wallpaper loading in `compositor.rs` (decode with `image`, upload texture, cover-fit draw). For the test, output size = source dims (64×48).
- [ ] **Step 4: Run, verify pass** — `cargo test -p render-core --test engine_test` → PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(render-core): Engine offscreen render + wallpaper backgrounds"`

---

### Task 9: `Engine::export` — render every frame → encode → mux

**Files:**
- Create: `src-tauri/render-core/src/encode.rs` (openh264 encode + mp4 mux; mirror `src-tauri/src/encoder.rs` logic, pure/no-tauri)
- Modify: `engine.rs` (add `export`), `lib.rs` (`pub mod encode;`)
- Test: `src-tauri/render-core/tests/export_test.rs`

**Interfaces:**
- Produces:
  - `encode.rs`: `pub struct Mp4Encoder { .. }` with `new(width, height, fps) -> Result<_, EngineError>`, `encode_rgba(&mut self, rgba: &[u8]) -> Result<(), EngineError>` (RGBA→I420→openh264→buffer NALs), `finish(self, out: &Path) -> Result<(), EngineError>` (mp4 mux with SPS/PPS). Reuse the exact openh264 `EncoderConfig` + mp4 mux structure from `src-tauri/src/encoder.rs`.
  - `Engine::export(&mut self, doc: &ProjectDoc, out: &Path, mut progress: impl FnMut(f32)) -> Result<(), EngineError>` — for each `frame_index in 0..frame_count`: `render_to_texture(doc, i)` → `encoder.encode_rgba(&rgba)` → `progress(i/n)`; then `encoder.finish(out)`.

**Acceptance:** export the `solid.mp4` fixture through a default doc → the output mp4 demuxes with the expected dimensions (source dims) and the same frame count; re-open it with `Mp4FrameSource` and confirm `frame_count` and `dimensions` match.

- [ ] **Step 1: Write the failing export test**

```rust
#[test]
fn export_produces_playable_mp4() {
    let src = render_core::decode::Mp4FrameSource::open(std::path::Path::new("tests/fixtures/solid.mp4")).unwrap();
    let n = render_core::decode::FrameSource::frame_count(&src);
    let mut engine = render_core::engine::Engine::new(Box::new(src)).unwrap();
    let doc = render_core::doc::ProjectDoc::new_default("solid.mp4".into());
    let out = std::env::temp_dir().join("export_test.mp4");
    let mut last = 0.0; engine.export(&doc, &out, |p| last = p).unwrap();
    assert!(last > 0.99);
    let reopened = render_core::decode::Mp4FrameSource::open(&out).unwrap();
    assert_eq!(render_core::decode::FrameSource::frame_count(&reopened), n);
}
```

- [ ] **Step 2: Run, verify failure** — `cargo test -p render-core --test export_test` → FAIL.
- [ ] **Step 3: Implement** `encode.rs` (mirror `src-tauri/src/encoder.rs`: BGRA path there is BGRA→I420; here convert RGBA→I420) and `Engine::export`. Output dims = `engine.output_size()`.
- [ ] **Step 4: Run, verify pass** — `cargo test -p render-core --test export_test` → PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(render-core): Engine::export (render -> openh264 -> mp4)"`

---

### Task 10: Project persistence (macroni)

**Files:**
- Create: `src-tauri/src/project_store.rs`
- Modify: `src-tauri/src/lib.rs` (`mod project_store;` + commands)
- Test: `src-tauri/src/project_store.rs` `#[cfg(test)]`

**Interfaces:**
- Consumes: `render_core::doc::ProjectDoc`; macroni's existing recordings store / app-data dir helpers.
- Produces:
  - `project_store::project_path(app_data: &Path, recording_id: &str) -> PathBuf` → `<app_data>/projects/<recording_id>.project.json`.
  - `load_project(app_data, recording_id) -> Result<Option<ProjectDoc>, String>` (None if no file).
  - `save_project(app_data, recording_id, doc) -> Result<(), String>` (atomic write, mkdir projects/).
  - Tauri commands: `studio_load_project(recording_id) -> Result<ProjectDoc, String>` (returns saved doc, or a `new_default` built from the recording's `VideoMetadata.path` if none), `studio_save_project(recording_id, doc) -> Result<(), String>`.

- [ ] **Step 1: Write the failing round-trip test** (save a `ProjectDoc` to a tempdir, load it back, assert equal; load of missing id returns `Ok(None)`). Use `tempfile`.
- [ ] **Step 2: Run, verify failure** — `cargo test -p macroni project_store` → FAIL.
- [ ] **Step 3: Implement** `project_store.rs` (serde_json + atomic write via temp+rename, mirroring `recordings_store.rs` patterns) and the two commands.
- [ ] **Step 4: Run, verify pass** — `cargo test -p macroni project_store` → PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(studio): ProjectDoc sibling-file persistence + load/save commands"`

---

### Task 11: Host preview — render composited frames to the native surface (macroni)

**Files:**
- Modify: `src-tauri/src/preview_surface.rs`, `src-tauri/src/lib.rs`
- (No unit tests — visual verification by the human, like Phase 0 Task 5.)

**Interfaces:**
- Consumes: `render_core::engine::Engine`, `render_core::doc::ProjectDoc`, the native surface plumbing from Phase 0 (NSView + CAMetalLayer, `contentLayoutRect` y-flip).
- Produces (replaces the spike command):
  - State: `StudioState { engine: Mutex<Option<Engine>>, surface: Mutex<Option<SpikeSurface>> }` (reuse the surface struct).
  - `studio_attach_surface(window, x, y, w, h)` — create/reposition the CAMetalLayer-backed NSView under the transparent webview (the Phase 0 logic, kept).
  - `studio_open_preview(window, recording_id, x, y, w, h)` — build an `Engine` from the recording's screen mp4, attach the surface, render frame 0 of the loaded doc.
  - `studio_render_preview(doc: ProjectDoc, frame_index: u32)` — `engine.render_to_texture` is for offscreen; for the surface, add `Engine::render_to_surface(&mut self, doc, frame_index, &wgpu::Surface, surface_format)` that composites then blits/presents to the surface. Render on demand (called when the doc or scrub position changes). NO continuous playback loop this phase.

> NOTE: `Engine::render_to_surface` is new render-core API — add it in this task (it belongs to render-core, takes a `&wgpu::Surface` which is host-agnostic wgpu, NOT tauri). It composites to an offscreen texture then copies into the surface's current texture (or renders the final pass directly to the surface view). Keep the surface/objc2 code in macroni; the wgpu surface object is created in macroni and passed in.

- [ ] **Step 1: Add `Engine::render_to_surface`** in `render-core/engine.rs` — composite per doc, then render/copy to the provided surface's current texture; `surface.get_current_texture()` returns the `CurrentSurfaceTexture` enum (match `Success|Suboptimal`). Returns `Result<(), EngineError>`. (No automated test — exercised via the host; add a `// smoke: covered by host preview` note.)
- [ ] **Step 2: Rewrite `preview_surface.rs`** to hold `StudioState`, build the `Engine` in `studio_open_preview`, keep the Phase 0 surface attach + `contentLayoutRect` y-flip, and route `studio_render_preview` through `Engine::render_to_surface`. Register the new commands in `lib.rs`; remove the `spike_show_surface` command + `SpikeState`.
- [ ] **Step 3: Build** — `cd src-tauri && cargo build` → 0 errors. (Visual verification deferred to the human after Task 12.)
- [ ] **Step 4: Commit** — `git add -A && git commit -m "feat(studio): native preview renders composited frames via Engine"`

---

### Task 12: React StudioEditor — background picker, framing controls, export

**Files:**
- Create: `src/components/studio/StudioEditor.tsx`, `BackgroundPicker.tsx`, `FramingControls.tsx`, `ExportButton.tsx`, `src/hooks/useProjectDoc.ts`, `src/types/project.ts`
- Modify: `src/windows/studio.tsx` (render `<StudioEditor/>` instead of `<StudioSpike/>`; keep the global reset + fixed/non-scroll layout)
- Delete: `src/components/studio/StudioSpike.tsx`

**Interfaces:**
- Consumes commands: `studio_load_project`, `studio_save_project`, `studio_open_preview`, `studio_render_preview`, `studio_export`. (Add `studio_export(recording_id, doc) -> Result<String, String>` command in `engine`/macroni wrapping `Engine::export` to a chosen output path; emit progress via a Tauri event `studio-export-progress`.)
- `types/project.ts`: TS interfaces mirroring `ProjectDoc` (version, media, framing{ background, paddingPx, borderRadiusPx, shadow }, …). Use `snake_case` matching serde (or add `#[serde(rename_all="camelCase")]` to the Rust structs and use camelCase in TS — **pick camelCase**: add `#[serde(rename_all = "camelCase")]` to `ProjectDoc` + sub-structs in Task 1’s types and use camelCase in TS). *(If Task 1 already shipped snake_case, this task adds the rename and updates the round-trip test.)*

- [ ] **Step 1: Add the `studio_export` command + progress event** (macroni): spawn the export on a blocking thread, call `Engine::export` with a progress closure that `app.emit("studio-export-progress", p)`, write to `<app_data>/exports/<id>-<ts>.mp4`, return the path. Build.
- [ ] **Step 2: Implement `useProjectDoc.ts`** — load the doc on mount (`studio_load_project`), expose `doc` + `update(partial)` that merges into `framing`, debounces `studio_save_project` + `studio_render_preview(doc, frameIndex)` (~60ms). 
- [ ] **Step 3: Implement `StudioEditor.tsx`** — fixed non-scroll layout: a left/bottom control panel + a centered transparent `#preview-hole`; on mount call `studio_open_preview(recordingId, holeRect…)`; re-attach on resize (reuse the Phase 0 rect-from-getBoundingClientRect×dpr logic). Render `<BackgroundPicker/>`, `<FramingControls/>`, `<ExportButton/>`.
- [ ] **Step 4: Implement the panels** — `BackgroundPicker` (solid color input, gradient from/to/angle, wallpaper picker from bundled `public/wallpapers` if present else a file path), `FramingControls` (padding/radius/shadow sliders), `ExportButton` (calls `studio_export`, shows progress from the `studio-export-progress` event). Delete `StudioSpike.tsx`; point `studio.tsx` at `StudioEditor`.
- [ ] **Step 5: Verify** — `npx tsc --noEmit` → 0; `npm run build` → emits `studio` assets; `cd src-tauri && cargo build` → 0. Commit: `git add -A && git commit -m "feat(studio): React editor — background picker, framing controls, export"`
- [ ] **Step 6: HUMAN visual verification** (record results for the Phase 1 wrap-up): `cargo tauri dev` → open the studio window for a recording → the video shows framed on the background; changing background/padding/radius/shadow updates the live preview; Export produces a playable mp4 whose look matches the preview.

---

## Self-Review

**1. Spec coverage (design spec §8 acceptance criteria):**
- "Open a prior recording; see the video framed on a background with padding/rounded corners/shadow, live" → Tasks 4–8 (compositor) + 11 (surface) + 12 (UI). ✓
- "Changing background/padding/radius/shadow updates preview without restart" → Task 12 (`useProjectDoc` debounced `studio_render_preview`). ✓
- "Export produces a playable mp4 whose frames match the preview (same compositor)" → Task 9 (`Engine::export` uses the same `Compositor`) + Task 12 Step 1. ✓
- "`ProjectDoc` persists and reloads round-trip" → Tasks 1 + 10. ✓
- Tracked Phase-0 debt: panic-in-library → Task 3; O(n²) decode → Task 2. ✓ (Throughput measurement on a real recording remains a manual step — fold into Task 11/12 human verification.)

**2. Placeholder scan:** GPU shader steps give starter WGSL + exact golden assertions (the implementer iterates the shader to pass concrete pixel checks — that is the spec, not a placeholder). The `Wallpaper` gray fallback in Task 4 is explicitly superseded in Task 8 (not left dangling). No "TBD/handle edge cases/write tests for the above".

**3. Type consistency:** `RgbaFrame{width,height,data}` (Phase 0) consumed unchanged in Tasks 5/8/9. `Gpu`/`GpuError` (Task 3) used in Tasks 4–9. `Compositor::render_frame` signature is stable across Tasks 5–8. `ProjectDoc`/`Framing`/`Background` (Task 1) used in Tasks 4–12. `Engine` (Task 8) extended in Tasks 9/11. `FrameSource` (Task 2) consumed by `Engine` (Task 8). **Casing:** Task 12 mandates `#[serde(rename_all="camelCase")]` on the doc types — Task 1 should adopt camelCase from the start to avoid churn (note added in Task 1’s implementer dispatch).

---

## Notes for Phases 2–4 (written after Phase 1 lands)
- Phase 2 (auto-zoom): add a zoom camera transform to `Compositor::render_frame` driven by `doc.zoom_regions` evaluated at `t`; dense cursor telemetry on the capture side (rdev) + dwell heuristic + spring smoothing; editable timeline UI. Needs the real-recording decode-throughput number from Phase 1’s human verification to size any frame cache.
- Phase 3 (cursor polish): hide OS cursor at capture; redraw smooth cursor + click ripples as a compositor layer above the video.
- Phase 4 (webcam): capture-side camera recording (second mp4) + a webcam overlay layer in the compositor.
