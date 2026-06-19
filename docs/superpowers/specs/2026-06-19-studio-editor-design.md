# Studio Editor — Screen Studio-style recording editor for macroni

- **Date:** 2026-06-19
- **Status:** Design approved (architecture). First sub-project (Phase 0 + Phase 1) detailed below.
- **Author:** Bryant Le (with Claude)

## 1. Goal

Turn macroni from a screen/macro recorder into a Screen Studio-style **recording
editor**: after you stop recording, the app auto-generates zoom moments from your
click activity, applies a polished background/frame, and lets you refine everything
on a timeline before exporting a finished video.

Four user-facing effect families, all in scope:

1. **Auto-zoom & pan** — automatically zoom/pan into clicks and the active cursor
   region; editable on a timeline.
2. **Cursor polish** — smooth, eased cursor motion; click ripples/highlights; an
   enlarged redrawn cursor.
3. **Backgrounds & framing** — gradient/wallpaper/solid background behind the
   recording, with padding, rounded corners, and a drop shadow.
4. **Webcam overlay** — a camera bubble composited in a corner.

Interaction model: **auto + refine** (true Screen Studio) — the app auto-generates
effects, and an editor lets the user add/adjust/delete them before export.

## 2. Long-term direction (informs the design, not built now)

The frontend will eventually migrate from the Tauri webview (React) to **GPUI**
(pure-Rust UI), *after* the studio editor is fully functional. This is a north
star, not current work, but it shapes one decision now: the rendering engine is
built as a **host-agnostic Rust core** so the eventual GPUI migration swaps only
the presentation layer, not the engine. GPUI is wgpu-based, so choosing wgpu now
is forward-compatible.

## 3. Locked decisions (from brainstorming)

| Decision | Choice | Rationale |
|---|---|---|
| Rendering | **Rust + wgpu**, single renderer for preview *and* export | No preview/export drift; forward-compatible with GPUI |
| Preview surface | **Live native surface** — wgpu → Metal layer under a transparent region of the webview | True real-time editing feel; scaffolding GPUI will later delete |
| Source frames | **Decode `screen.mp4` via `mp4` demux + `openh264` decode** | Both deps already linked; adds **zero** new media dependencies |
| Export | Rust compositor → `openh264` encode → `mp4` mux | Reuses macroni's existing encoder pipeline |
| Reuse | Port **openscreen's algorithms + schema** (MIT), not its TS renderer | Auto-zoom dwell heuristic, spring smoothing, project schema are pure logic |
| Platform | **macOS-first** | macroni's Windows video capture is already disabled upstream |

Attribution: openscreen (https://github.com/EtienneLescot/openscreen) is MIT.
Ported algorithms/schemas must carry attribution per its LICENSE.

## 4. System architecture

The center of gravity is a new **`render-core`** crate that knows nothing about
Tauri, React, or GPUI.

```
┌─ Capture (existing + small additions) ───────────────────────────┐
│  scap → openh264 → screen.mp4              (raw recording, as today)│
│  rdev → cursor telemetry → cursor.json     (NEW: dense sampling)    │
│  [option] hide OS cursor during capture     (NEW, Phase 3 only)     │
└────────────────────────────────────────────────────────────────────┘
                    │   ProjectDoc (JSON, serde) — the linchpin
                    ▼
┌─ render-core (Rust, wgpu, HOST-AGNOSTIC, no tauri dep) ───────────┐
│  FrameSource trait:  mp4 demux + openh264 decode → RGBA frames     │
│  Compositor scene graph:                                           │
│     background → video(zoom camera) → webcam → cursor → annotations │
│  Timeline eval: at time t, resolve every transform from ProjectDoc │
│  Two exits, SAME graph (no preview/export drift):                  │
│     • render_frame(target, t)   → live preview                     │
│     • export(out.mp4)           → openh264 encode + mp4 mux         │
└────────────────────────────────────────────────────────────────────┘
                    ▲                              ▲
        mutate doc  │                              │ render into surface
                    │                              │
┌─ Presentation adapter — TODAY: Tauri + React (thin, disposable) ──┐
│  React editor: timeline, background picker, zoom inspector, webcam │
│  Preview: wgpu → CAMetalLayer-backed NSView under a transparent    │
│           "hole" in the WKWebView, kept aligned to a React div     │
│  ── LATER: replace this layer with GPUI; render-core is untouched ─│
└────────────────────────────────────────────────────────────────────┘
```

### Crate boundary (enforces host-agnosticism)

`src-tauri` is currently a single crate. We convert it into a **Cargo workspace**:

- `render-core/` — new path crate. Depends on `wgpu`, `openh264`, `mp4`, `serde`,
  `bytemuck`/`glam` (math). **Must not depend on `tauri`.** This compile-time
  boundary is what makes the GPUI migration a layer swap rather than a rewrite.
- `macroni` (existing `src-tauri`) — depends on `render-core`; owns Tauri commands,
  the native preview surface, capture, and persistence.

### render-core interface (the deep module)

A small interface hiding the whole compositor:

```rust
pub struct Engine { /* wgpu device/queue, pipelines, decoder cache */ }

impl Engine {
    pub fn new(source: Box<dyn FrameSource>) -> Result<Self, EngineError>;
    /// Live preview: composite the frame at time `t` into a caller-owned surface.
    pub fn render_frame(&mut self, doc: &ProjectDoc, t_ms: u64, target: &RenderTarget) -> Result<(), EngineError>;
    /// Offline export: walk every frame, encode, mux to `out`.
    pub fn export(&mut self, doc: &ProjectDoc, out: &Path, progress: impl FnMut(f32)) -> Result<(), EngineError>;
}

pub trait FrameSource {
    fn frame_at(&mut self, t_ms: u64) -> Result<RgbaFrame, FrameError>;
    fn duration_ms(&self) -> u64;
    fn dimensions(&self) -> (u32, u32);
}
```

`RenderTarget` abstracts "where pixels go" — a wgpu surface (preview) or an
offscreen texture read back for encoding (export). The compositor code is identical
for both; this is what guarantees no drift.

## 5. The edit document (`ProjectDoc`)

The linchpin. A serde struct persisted next to each recording (extends today's
`recordings.json` model). Ported and slimmed from openscreen's `EditorProjectData`.
Preview and export are both a pure function of `(ProjectDoc, t)`.

```rust
struct ProjectDoc {
  version: u32,
  media: Media,                  // { screen_mp4, webcam_mp4?, cursor_json? }
  framing: Framing,              // { background, padding, border_radius, shadow, motion_blur }
  zoom_regions: Vec<ZoomRegion>, // {id, start_ms, end_ms, scale, focus{cx,cy}, source: Auto|Manual, easing}
  cursor: CursorStyle,           // { size, smoothing, click_effects }
  webcam: Option<WebcamLayout>,  // { layout, size, position, mask_shape, mirrored, reactive_zoom }
  trim_regions: Vec<TrimRegion>,
  speed_regions: Vec<SpeedRegion>,
  crop: CropRegion,
  aspect_ratio: AspectRatio,
  export: ExportSettings,        // { quality, format }
}
```

The React editor only ever mutates this doc (via Tauri commands); the renderer
only ever reads it. `version` enables migrations.

## 6. Phase decomposition

Each phase is its own spec → plan → implementation cycle. This document details
**Phase 0 + Phase 1** (the first sub-project). Later phases are sketched.

| Phase | Scope | Why this order |
|---|---|---|
| **0 — Spike** | Retire the two unknowns (below) | Cheapest way to validate the riskiest assumptions before committing |
| **1 — Backgrounds & framing** | Full `ProjectDoc` skeleton + complete preview↔export pipeline on the simplest effect | Proves the entire machine end-to-end with a static transform |
| 2 — Auto-zoom & pan | Dense cursor telemetry + dwell heuristic + editable zoom timeline + spring smoothing | First per-frame, data-driven effect |
| 3 — Cursor polish | Hide OS cursor on capture + redraw smooth cursor + click ripples | Depends on telemetry from Phase 2 |
| 4 — Webcam | Capture-side camera + overlay compositing | Touches the capture pipeline, most isolated |

## 7. Phase 0 — Spike (de-risk)

**Purpose:** prove the two assumptions the whole architecture rests on, with
throwaway-quality code. No editor UI, no `ProjectDoc` polish.

**Unknown A — native preview surface.** Can we render a wgpu/Metal surface *under*
a transparent region of macroni's WKWebView and keep it aligned to a React `<div>`
as the window resizes? macroni already uses `tauri-nspanel` (ahkohd) on macOS, so
AppKit/NSView access is established.

**Unknown B — Rust decode.** Can we demux `screen.mp4` with the `mp4` crate and
decode its H.264 with `openh264`'s decoder into RGBA frames at a usable rate?

**Acceptance criteria:**
- [ ] A solid-colored wgpu surface appears behind a transparent hole in the webview,
      sized/positioned to a React div, and stays aligned across a window resize.
- [ ] An existing `screen.mp4` is demuxed + decoded in Rust; one decoded frame is
      composited (video sprite on a colored background) onto that surface.
- [ ] Rough decode throughput measured and recorded (frames/sec at capture
      resolution) — informs whether seek/scrub needs a frame cache in Phase 1.

**If Unknown A fails:** fall back to "stream frames to a `<canvas>`" preview (slower,
simpler) without changing `render-core`. **If Unknown B is too slow:** add a frame
cache / proxy resolution, or retain frames at capture time.

## 8. Phase 1 — Backgrounds & framing

**Scope (YAGNI — only what proves the pipeline):**
- `ProjectDoc` defined and persisted (full struct, but only `framing` is wired to
  the renderer this phase; other fields parse and round-trip but are inert).
- `render-core` compositor with two layers: **background** (solid + linear gradient
  + bundled wallpaper image) and **video** with **padding, border-radius (rounded
  corners), and drop shadow**. No zoom/cursor/webcam yet.
- Live preview via the Phase-0 surface, re-rendering on doc change.
- **Working export**: render every frame offline through the same compositor →
  openh264 encode → mp4 mux → file the user can open.
- Minimal React editor panel: background picker (color/gradient/wallpaper),
  padding/radius/shadow sliders, an Export button with progress.

**Explicitly NOT in Phase 1:** auto-zoom, cursor redraw, webcam, trim/speed, crop,
GIF export, annotations. Those fields exist in `ProjectDoc` but are not rendered.

**New/changed files (indicative):**
- `render-core/` (new crate): `lib.rs`, `engine.rs`, `compositor.rs`,
  `frame_source.rs` (mp4+openh264 decode), `doc.rs` (`ProjectDoc` types),
  `shaders/` (wgsl for background + framed video quad).
- `src-tauri/Cargo.toml` → workspace; depend on `render-core` + add `wgpu`.
- `src-tauri/src/`: `studio.rs` (Tauri commands: `open_project`, `update_doc`,
  `export_project`, surface lifecycle), `preview_surface.rs` (NSView/CAMetalLayer
  wiring under the webview), extend `recordings_store.rs` to persist `ProjectDoc`.
- `src/`: `components/studio/StudioEditor.tsx`, `BackgroundPicker.tsx`,
  `FramingControls.tsx`, `ExportButton.tsx`; `hooks/useProjectDoc.ts`; types in
  `src/types.ts`.

**Acceptance criteria:**
- [ ] Open a prior recording in the studio editor; see the video framed on a chosen
      background with padding/rounded corners/shadow, live.
- [ ] Changing background/padding/radius/shadow updates the preview without restart.
- [ ] Export produces a playable `.mp4` whose frames match the preview (same
      compositor), at the recording's resolution and duration.
- [ ] `ProjectDoc` persists and reloads round-trip (serde).

## 9. Module / interface design

- **`render-core` is the one deep module.** Its interface is `Engine` +
  `FrameSource` + `ProjectDoc`. Callers (Tauri now, GPUI later) never learn wgpu,
  openh264, or mp4 details. The interface is the test surface (§10).
- **`FrameSource` is a real seam** (≥2 adapters anticipated: mp4+openh264 now;
  VideoToolbox later if decode is slow). Keep it minimal until the second adapter
  exists.
- **`preview_surface.rs` is intentionally shallow and disposable** — it's the
  webview-alignment scaffolding GPUI will delete. Do not over-invest.

## 10. Testing strategy (per macroni's layered discipline)

- **Unit (render-core, host-free):** `ProjectDoc` serde round-trip; timeline
  evaluation (transform at time `t` for given `framing`); `FrameSource` decode of a
  tiny fixture mp4 returns expected dimensions/frame-count.
- **Golden-frame tests:** render a known `ProjectDoc` at fixed `t` to an offscreen
  texture, read back pixels, compare against a committed reference PNG within a
  tolerance. This is the core guard that preview == export and that effects are
  correct. Runs headless via wgpu offscreen — no window needed.
- **Export integration:** export a short fixture → assert the output mp4 demuxes,
  has expected dimensions/duration/frame-count.
- **Frontend:** `useProjectDoc` reducer tests (vitest) — doc edits produce expected
  doc state; component smoke tests for the editor panel.
- **Manual (macOS only):** the live native-surface alignment, which can't be
  asserted headlessly.

## 11. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Native surface under transparent webview is fragile on macOS | Phase 0 spike retires it first; canvas-streaming fallback keeps `render-core` unchanged |
| openh264 decode too slow for smooth scrubbing | Phase 0 measures throughput; add frame cache / proxy resolution if needed |
| wgpu adds build/CI weight (shaders, GPU in CI) | Golden-frame tests use offscreen wgpu (llvmpipe/software adapter in CI); gate behind a feature if CI lacks GPU |
| Preview/export drift | Architecturally prevented — one compositor, two `RenderTarget`s; golden-frame tests assert parity |
| Scope creep across four effect families | Strict phase gates; later-phase `ProjectDoc` fields inert until their phase |

## 12. Open questions (resolve during Phase 0/1, not blocking)

- Exact `openh264` decoder API surface in the 0.6 crate (verify in Phase 0).
- Whether to persist `ProjectDoc` inline in `recordings.json` or as a sibling
  `<id>.project.json` (lean toward sibling file for separation).
- Color management (BGRA vs RGBA, sRGB) between scap capture, openh264, and wgpu —
  validate visually in Phase 0.

## 13. References

- openscreen (MIT): `tmp/openscreen` (gitignored local clone).
  - Auto-zoom dwell heuristic: `src/components/video-editor/timeline/zoomSuggestionUtils.ts`
  - Spring smoothing: `src/components/video-editor/videoPlayback/zoomSpring.ts`
  - Project schema: `src/components/video-editor/types.ts`, `projectPersistence.ts`
  - Cursor rendering: `src/components/video-editor/videoPlayback/cursorRenderer.ts`
  - Frame renderer (preview==export pattern): `src/lib/exporter/frameRenderer.ts`
</content>
