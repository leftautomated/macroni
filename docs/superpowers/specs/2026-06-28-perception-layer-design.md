# Multi-Modal Perception Layer — Design

**Goal:** Add a pluggable layer that extracts structured observations from screen
frames — text (OCR), image/template matches, and color samples — both live and
from saved recordings, so users can define and test "watch targets" in the
Studio. This is the foundation that a later **conditionals** feature will branch
on (e.g. "wait until *Submit* appears, then click it").

**Status:** Foundation only. Conditional/branching logic and an AI
similarity/learning layer are explicitly out of scope (separate specs).

**Tech stack:** Tauri 2 (Rust backend, React/Vite frontend). macOS-first
(Vision.framework for OCR); architecture keeps a clean seam for a Windows OCR
backend later. Template-match and color extractors are pure Rust (cross-platform
from day one).

---

## Global Constraints

- **macOS-first, Windows-ready.** OCR uses macOS Vision in v1. The `Extractor`
  trait hides the engine so a Windows OCR backend (Tesseract or
  `Windows.Media.Ocr`) drops in later without touching callers. Template-match
  and color extractors are pure Rust and work on all platforms now.
- **Multi-modal by design, visual-only in v1.** Data model carries a `Modality`
  tag (`Visual` now, `Audio` reserved) so audio extractors slot in later with no
  model rewrite. No audio code ships in this spec.
- **Never destabilize capture or playback.** The perception worker runs off the
  existing capture/encode path; any extractor or decode failure logs a warning
  and yields an empty/`None` result — it never panics or stalls recording,
  playback, or the UI.
- **Continuous capture is throttled** to ~1–2 fps with drop-on-backpressure.
- **Continuous OCR is opt-in.** Full-frame OCR transcribes *everything* visible
  on screen — notifications, messages, briefly-visible credentials — into a
  plaintext sidecar that is far easier to grep, sync, or accidentally share than
  the video itself. A new `#[serde(default)]` toggle on `AppSettings`
  (`perception.continuous_ocr`, default **off**) gates the continuous worker.
  On-demand evaluation ("Test" buttons) is unaffected by the toggle.
- **Backward compatible.** New `Recording` fields are `#[serde(default)]`;
  recordings made before this feature load unchanged.
- **Deferred (NOT in this spec):** conditional/branching playback logic,
  conditional-authoring UI, AI similarity/learning, audio extractors, any
  cross-platform OCR backend.
- **Normalized coordinates everywhere.** All regions are stored as `f32` in
  `[0,1]` so they map across capture resolution, the displayed (letterboxed)
  video, and the live screen.

---

## Architecture Overview

A perception pipeline: **source → extractor → observation.**

- **`PerceptionSource`** unifies frame access: *live* (a one-shot screen grab,
  and the existing BGRA capture stream) and *recording* (reuse `render-core`'s
  on-demand RGBA MP4 decoder). Extractors are source-agnostic. (Named
  `PerceptionSource`, not `FrameSource` — render-core already exports an
  index-based `trait FrameSource` in `decode.rs`; two same-named traits in one
  workspace invites confusion.)
- **`Extractor`** trait: `(frame, region) -> ObservationResult`. Three
  implementations in v1: `TextOcr` (macOS Vision), `TemplateMatch` (pure Rust),
  `ColorSample` (pure Rust).
- **`Target`** = a saved, named, normalized region + one extractor's config. The
  user authors targets by dragging a box on a frame in the Studio.
- **`Observation`** = a timestamped extraction result. Two ways they arise:
  1. **Continuous during recording** (opt-in, see Global Constraints) — a
     throttled worker runs *full-frame OCR* (~1–2 fps) and stores
     `target_id: None` observations → a "what text was on screen, when" timeline
     for review. (Template/color are NOT run here — they need a reference
     image/color that doesn't exist during a fresh recording.)
  2. **On-demand evaluation** — evaluate one `Target` against one frame (live
     screen *or* a decoded recording frame). This is the "Test" button in the
     Studio and the exact primitive conditionals will call later.

New Rust module: `src-tauri/src/perception/` (`mod.rs`, `source.rs`,
`extractor.rs`, `engine.rs`, `ocr_macos.rs`). The macOS Vision call lives in
`ocr_macos.rs` behind the trait.

### Data flow

- **Recording:** capture thread → (unchanged) encoder for video **and** → a
  tee to the throttled perception worker (full-frame OCR) → in-memory
  observation buffer → flushed to the `observations/{id}.json` sidecar on stop.
  Today there is no frame stream to "subscribe" to — acquisition feeds the
  encoder over a single bounded `sync_channel(3)` (`capture.rs`); the tee is a
  new, deliberately minimal change to that hot path, specified under Run modes.
- **Studio review:** load the sidecar → render an overlay/timeline of detected
  text; decode frames on demand; drag a region → create a `Target`; "Test" runs
  an extractor on that frame or the live screen.
- **Live on-demand:** one screen grab → extractor → result.

---

## Data Model

Rust types live in `src-tauri/src/perception/mod.rs` (or `types.rs`); a TS mirror
goes in `src/types.ts`.

```rust
enum Modality { Visual, /* Audio reserved for a later spec */ }

/// Resolution-independent box; all fields normalized [0,1].
struct Region { x: f32, y: f32, w: f32, h: f32 }

struct Target {
    id: String,
    name: String,
    modality: Modality,        // Visual in v1
    region: Option<Region>,    // Some for visual; None reserved for audio
    kind: TargetKind,
    created_at: i64,
}

enum TargetKind {
    TextOcr       { expect: Option<String> },          // OCR the region; optional text to match
    TemplateMatch { image: String, threshold: f32,     // path to captured reference PNG
                    source_px: [u32; 2] },             // dimensions of the source it was cropped from
    ColorSample   { rgb: [u8; 3], tolerance: f32 },    // tolerance: max per-channel diff, 0–255
    // audio kinds added in a later spec
}

struct Observation {
    target_id: Option<String>, // None = ad-hoc / continuous full-frame
    timestamp_ms: i64,         // video-relative (same origin as encoder PTS / input events)
    result: ObservationResult,
}

enum ObservationResult {
    Text     { spans: Vec<TextSpan> },                 // {text, box: Region, confidence}
    Template { matched: bool, location: Option<Region>, score: f32 },
    Color    { rgb: [u8; 3], matched: bool },
}

struct TextSpan { text: String, region: Region, confidence: f32 }
```

Two semantics worth pinning down here rather than in code review:

- **`Observation.timestamp_ms` is video-relative** — the same origin the encoder
  uses for frame PTS and the input-event timeline. A start-time-vs-first-frame
  mismatch would shift every overlay box, so the continuous worker stamps
  observations from the captured frame's `timestamp_ms`, not wall clock.
- **`ColorSample.tolerance`** means *maximum per-channel absolute difference* on
  the 0–255 scale: `matched = max(|r−er|, |g−eg|, |b−eb|) ≤ tolerance`. Chosen
  over Euclidean distance because it's trivial to explain in the UI and the TS
  mirror can't drift from it.

### Storage

- **Targets** — inline on `Recording`: `#[serde(default)] targets: Vec<Target>`.
  Few and small; backward compatible.
- **Template images** — files at `targets/{recording_id}/{target_id}.png`
  (same pattern as `videos/`).
- **Observations** (continuous-capture timeline) — **sidecar**
  `observations/{recording_id}.json`, loaded on demand in the Studio. Keeps
  `recordings.json` lean (1–2 fps over a long recording is hundreds of entries).
- **Deletion & cleanup.** Deleting a recording also removes
  `observations/{id}.json` and `targets/{id}/`. The existing orphan sweep in
  `RecordingsStore` (which prunes `videos/*.mp4` with no matching recording,
  `recordings_store.rs`) extends to both new artifact kinds. Missing files are
  not an error — legacy and OCR-disabled recordings simply have no sidecar.
- TS mirror types added to `src/types.ts`.

`Recording` gains exactly one new serialized field (`targets`); observations are
never inlined.

---

## Engine & Run Modes

### `PerceptionSource` (`source.rs`)

```rust
trait PerceptionSource {
    /// One frame as RGBA8 (width*height*4), plus its dimensions.
    fn frame_at(&mut self, /* live: now; recording: timestamp_ms */) -> Result<Rgba, Error>;
    fn dimensions(&self) -> (u32, u32);
}
```

- **Live source** — one-shot screen grab via the existing `scap`/capture stack,
  returning native-resolution pixels. Used by on-demand "test on live screen"
  and (later) by conditionals during playback.
- **Recording source** — wraps `render-core`'s `Mp4FrameSource`
  (`src-tauri/render-core/src/decode.rs`), seeking to a timestamp and returning
  the decoded RGBA frame. `Mp4FrameSource` is index-based with no timestamp
  API; the wrapper maps `index = round(timestamp_ms × fps / 1000)` (clamped to
  `frame_count − 1`) using `VideoMetadata.fps`. This relies on the encoder's
  output being **constant frame rate** — it already repeats the last frame to
  hold cadence (`CaptureSink::repeat_last`) — so backpressure drops don't create
  timing gaps in the file. If encoder output ever becomes VFR, this mapping must
  switch to per-sample PTS from the demuxer; a round-trip test (below) guards
  the assumption.

Capture frames are BGRA, recording frames RGBA; the source layer normalizes to a
single pixel order the extractors expect (documented constant), so extractors
never branch on source.

### `Extractor` (`extractor.rs`)

```rust
trait Extractor {
    fn extract(&self, frame: &Rgba, region: &Region) -> ObservationResult;
}
```

- **`ColorSample`** — average the region's pixels; compare to expected using the
  per-channel tolerance rule defined in the data model. Pure Rust.
- **`TemplateMatch`** — normalized cross-correlation of the reference image over
  the region; report best location + score, `matched = score >= threshold`.
  Pure Rust. **Resolution handling:** regions are normalized, so the pixel crop
  of the same region differs in size across sources (recording at capture res
  vs. live screen at current res) — and "author on recording, test on live" is
  the flagship flow. Before correlating, the extractor scales the stored
  template by the ratio of the evaluated source's dimensions to the template's
  recorded source dimensions (stored alongside the PNG). This handles same-
  display resolution/scale changes; true multi-scale search and feature
  matching remain deferred, and a score near zero with mismatched dimensions
  should surface a hint in the "Test" result rather than fail silently.
- **`TextOcr`** — crop the region, hand it to `ocr_macos::recognize` →
  `VNRecognizeTextRequest` → spans of text + normalized boxes + confidence.
  macOS-only; the trait isolates it. Vision reports normalized boxes with a
  **bottom-left origin**; `ocr_macos.rs` flips Y into the top-left `Region`
  convention (a classic silent bug — covered by a dedicated test). The
  continuous pass uses the `.fast` recognition level (accurate mode can take
  hundreds of ms per retina frame — a core pinned for the whole recording);
  on-demand "Test" uses `.accurate`.

### Run modes (`engine.rs`)

1. **Continuous during recording** (gated by the `perception.continuous_ocr`
   setting). Frames reach the worker via a **tee in the acquisition loop** —
   the only change this spec makes to the capture hot path. Mechanism: a second
   bounded `sync_channel(1)` alongside the existing acquisition→encoder
   `sync_channel(3)`. The acquisition thread checks the **rate limiter (~1–2
   fps) first** and only then clones the frame and `try_send`s it — a retina
   BGRA frame is ~25–50 MB, so cloning must happen at the sampled rate, never
   per captured frame. `try_send` on a full channel **drops the sample**
   (mirroring the existing drop-on-backpressure policy); the encoder path is
   never blocked or altered. For each sampled frame the worker runs
   **full-frame `TextOcr`** and pushes an `Observation { target_id: None, … }`
   to a buffer. On `stop_recording`, the buffer flushes to the sidecar (a crash
   mid-recording loses observations — acceptable for a review artifact; the
   video itself is unaffected). Rationale for OCR-only: a fresh recording has
   no targets yet (the user authors those later over the recorded frames), and
   full-frame OCR is the generally useful review artifact; template and color
   need a not-yet-existing reference.

2. **On-demand evaluation.** Given a `Target` (or ad-hoc region + kind) and a
   source selector (live / recording-at-T), build the source, fetch one frame,
   run the extractor, return the `ObservationResult`. No persistence unless the
   caller saves it. This is the Studio "Test" action and the conditionals
   primitive.

### Error handling

- Extractor error → logged warning + empty/`None` result.
- Frame grab/decode error → `Err` surfaced to the command, shown as a soft
  message in the Studio; never crashes capture/playback.
- Continuous worker errors are isolated per frame: one bad frame is skipped, the
  worker continues.

---

## Tauri Command Surface

Added to `src-tauri/src/lib.rs` `invoke_handler`:

- `extract_region(source, region, kind, trace_id) -> ObservationResult`
  One-shot evaluation. `source` selects live screen or `{recording_id,
  timestamp_ms}`. Powers both "Test" buttons.
- `save_target(recording_id, target, timestamp_ms?, trace_id) -> Recording`
  Persists a target on the recording. For `TemplateMatch` targets the backend
  decodes the recording frame at `timestamp_ms` and crops the region to the
  template PNG itself — a frontend canvas capture would hand back compressed
  `<video>`-element pixels at display resolution, not the native decoded frame.
- `delete_target(recording_id, target_id, trace_id) -> Recording`
- `load_observations(recording_id, trace_id) -> Vec<Observation>`
  Reads the sidecar for the review timeline.

Continuous observations are written by the recording path (not a UI command).
All commands follow the existing `observability::trace_command` + `trace_id`
pattern.

---

## Studio UX

All in `src/components/studio/`.

### 1. Drag-to-select → create a Target

On `StudioPlayer`, **drag (past a small threshold) on the paused frame selects a
region**; a plain **click stays play/pause** (same click-vs-drag split the
timeline uses for seek-vs-loop). No mode toggle. On release, a popover asks which
extractor:

- **Text** → OCR the region (optional "match this text").
- **Image** → the backend decodes the frame at the playhead and crops the
  region to the template PNG (`save_target` with `timestamp_ms`).
- **Color** → sample the region's average color as expected.

Saving calls `save_target`; the target then renders as a labeled rectangle.

### 2. Overlays

- **Player overlay** — an absolutely-positioned layer aligned to the **displayed
  (letterboxed) video rect** (computed from intrinsic vs. element size, since
  normalized regions must map onto the visible video, not the element box). Draws
  saved target rectangles and, when the playhead is on a continuous-OCR
  observation, the detected text boxes.
- **Timeline "Perception" lane** — a new lane alongside mouse/keys with ticks
  where observations exist; click a tick to seek. A side strip lists targets.

### 3. "Test" affordance

On a selected target: **Test on this frame** (decode at playhead → extract →
inline result) and **Test on live screen** (one-shot grab → extract → result).
Both call `extract_region`.

### Deferred UI

No conditional-authoring UI and no AI-similarity tuning here — this layer only
*creates and tests* targets.

---

## Testing Strategy

Matches the repo's layers (vitest + RTL; `cargo test`; fmt/clippy/coverage
gates).

**Rust (pure, CI-safe):**
- `ColorSample` / `TemplateMatch` — unit tests over tiny synthetic buffers
  (solid block → known color; planted template → asserted location + score;
  near-miss → below threshold; tolerance boundary at exactly `max-diff ==
  tolerance`; template scaled by a dimension ratio still matches).
- `TextOcr` — Vision is macOS-only and not CI-testable; behind the `Extractor`
  trait. Tests cover trait wiring with a **fake extractor**, not Vision (mirrors
  how playback hides `rdev` behind a simulator trait). The bottom-left→top-left
  Y-flip is a pure function tested directly (fake Vision output → expected
  `Region`).
- Region mapping — normalized↔pixel round-trip, clamping, non-square aspect
  ratios.
- Timestamp→index mapping — `round(ms × fps / 1000)` round-trip incl. clamping
  at the last frame, guarding the CFR assumption.
- Persistence — `targets` round-trip on `Recording` (incl. legacy recordings
  with none); observations sidecar read/write round-trip; delete removes the
  sidecar and `targets/{id}/`; orphan sweep prunes both.
- Continuous worker — throttle + drop-on-backpressure via a fake clock and fake
  source; asserts the rate cap, that it never blocks, and that no frame is
  cloned when the limiter isn't due; disabled setting → no worker spawned.

**Frontend (vitest + RTL):**
- Drag-to-select emits the correct normalized `Region` (mock
  `getBoundingClientRect` + letterbox math, like timeline tests).
- Overlay places target rects at correct % positions; Perception lane renders
  ticks from observations.
- "Test" buttons call `extract_region` with the right args (mock `invoke`).

**Coverage:** the macOS Vision file (`ocr_macos.rs`) joins the CI exclusion
regex that currently covers `permissions.rs` (`--ignore-filename-regex` in
`.github/workflows/test.yml`), so it doesn't drag the gate. (This branch
predates that CI change — rebase onto main before implementing.) The testable
core (extractors, mapping, persistence, throttle) stays high.

---

## Build Order (for the implementation plan)

1. Data model + persistence (`Target` on `Recording`, observations sidecar,
   delete/orphan-sweep cleanup, TS mirrors) — pure, fully testable.
2. Extractor trait + `ColorSample` + `TemplateMatch` (pure Rust) + region
   mapping — pure, fully testable.
3. `PerceptionSource` (recording via render-core incl. timestamp→index mapping;
   live one-shot grab).
4. `extract_region` command + Studio "Test on frame / live" + drag-to-select +
   target persistence/overlay (`save_target` backend template crop).
5. `TextOcr` via macOS Vision behind the trait (incl. Y-flip); wire it into
   `extract_region`.
6. Continuous throttled worker (capture tee + `perception.continuous_ocr`
   setting) + observations sidecar flush + the Perception lane/overlay for
   review. Before landing: measure `.fast`-mode OCR latency and CPU on a full
   retina frame to confirm the 1–2 fps budget holds on the oldest supported
   hardware.

Each step lands working, tested software on its own.
