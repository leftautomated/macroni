# Multi-Modal Perception Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract structured observations (OCR text, template matches, color samples) from screen frames — live and from saved recordings — with Studio UI to author and test "watch targets", per `docs/superpowers/specs/2026-06-28-perception-layer-design.md`.

**Architecture:** A perception pipeline `source → extractor → observation`. `PerceptionSource` unifies live one-shot grabs and decoded recording frames (via render-core's `Mp4FrameSource`); an `Extractor` trait hides macOS Vision OCR behind a seam; targets persist inline on `Recording`, observations in a JSON sidecar. A rate-gated tee off the capture acquisition thread feeds an opt-in continuous OCR worker.

**Tech Stack:** Rust (Tauri 2), objc2-vision (macOS Vision OCR), `png` crate, React + Vite + vitest/RTL.

## Global Constraints

- **macOS-first, Windows-ready.** OCR is macOS Vision behind the `Extractor` trait. Template/color extractors are pure Rust, cross-platform.
- **Visual-only in v1.** `Modality` carries `Visual` now; audio is reserved, no audio code.
- **Never destabilize capture or playback.** Extractor/decode failures log a warning and yield empty results; the tee never blocks the encoder path.
- **Continuous OCR is opt-in:** `AppSettings.perception.continuous_ocr`, default **off**.
- **Backward compatible:** new `Recording` field is `#[serde(default)]`; legacy recordings load unchanged.
- **Normalized coordinates everywhere:** regions are `f32` in `[0,1]`, top-left origin. Extractors consume **RGBA8** (`render_core::decode::RgbaFrame`); sources convert BGRA→RGBA.
- **`Observation.timestamp_ms` is video-relative** (frame wall-clock ts minus capture `start_ms`).
- **`ColorSample.tolerance` = max per-channel absolute diff, 0–255 scale.**
- **CFR assumption:** recording frame lookup is `index = round(ms × fps / 1000)` clamped; valid because the encoder holds cadence via `repeat_last`.
- **Deferred (do NOT build):** conditionals, conditional UI, AI similarity, audio extractors, cross-platform OCR, multi-scale template search.
- Rust checks: `cargo test` + `cargo fmt --all` + `cargo clippy` from `src-tauri/`. Frontend: `pnpm vitest run <file>`, `pnpm typecheck`, `pnpm lint:fix`. Frontend code style follows the existing files (double quotes, semicolons — biome is the arbiter).

## File Structure

Backend (`src-tauri/src/`):
- `perception/mod.rs` (NEW) — data model types, module root.
- `perception/extractor.rs` (NEW) — `Extractor` trait, region↔pixel mapping, crop, `ColorSampler`, Vision box mapping (pure, tested).
- `perception/convert.rs` (NEW) — BGRA→RGBA conversion (pixel-order canon).
- `perception/png_io.rs` (NEW) — PNG encode/decode for templates + Vision input.
- `perception/template.rs` (NEW) — `TemplateMatcher` (NCC + ratio scaling).
- `perception/source.rs` (NEW) — `PerceptionSource` trait, `RecordingSource`, `LiveSource`, `frame_index_for_ms`.
- `perception/commands.rs` (NEW) — Tauri commands.
- `perception/ocr_macos.rs` (NEW) — Vision call (coverage-excluded).
- `perception/gate.rs` (NEW) — `SampleGate` throttle.
- `perception/worker.rs` (NEW) — continuous worker.
- `types.rs` (MODIFY) — `Recording.targets`, `PerceptionSettings`.
- `recordings_store.rs` (MODIFY) — sidecar + targets storage, cleanup, sweep.
- `capture.rs` (MODIFY) — tee in acquisition loop.
- `recording_session.rs` (MODIFY) — hold worker handle.
- `lib.rs` (MODIFY) — `mod perception;`, command registration, start/stop wiring.
- `settings.rs` (MODIFY) — log new setting field.

Frontend (`src/`):
- `lib/video-rect.ts` (NEW) — contain-fit rect math.
- `components/studio/PerceptionOverlay.tsx` (NEW) — target rects + text boxes over video.
- `components/studio/CreateTargetPopover.tsx` (NEW) — extractor picker after drag.
- `components/studio/PerceptionPanel.tsx` (NEW) — target list + Test buttons.
- `components/studio/StudioPlayer.tsx` (MODIFY) — overlay host + drag-to-select.
- `components/studio/StudioTimeline.tsx` (MODIFY) — Perception lane.
- `components/studio/StudioEditor.tsx` (MODIFY) — wiring, observations load.
- `components/SettingsTab.tsx` (MODIFY) — perception toggle.
- `types.ts` (MODIFY) — TS mirrors.

CI: `.github/workflows/test.yml` (MODIFY, Task 7) — coverage exclusion.

---

### Task 1: Perception data model + `Recording.targets` + TS mirrors

**Files:**
- Create: `src-tauri/src/perception/mod.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod perception;`), `src-tauri/src/types.rs`, `src/types.ts`
- Test: `#[cfg(test)]` in `perception/mod.rs`; existing `recordings_store.rs` tests updated

**Interfaces (Produces):** `perception::{Modality, Region, Target, TargetKind, Observation, ObservationResult, TextSpan}` — all `#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]` (`Region`/`Modality` also `Copy`). `Recording` gains `targets: Vec<Target>`.

- [ ] **Step 1: Write failing serde tests** in `perception/mod.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn target_kind_serde_round_trips_with_house_tagging() {
        let kinds = vec![
            TargetKind::TextOcr { expect: Some("Submit".into()) },
            TargetKind::TemplateMatch { image: "targets/1/t1.png".into(), threshold: 0.8, source_px: [1920, 1080] },
            TargetKind::ColorSample { rgb: [10, 20, 30], tolerance: 12.0 },
        ];
        for kind in kinds {
            let json = serde_json::to_string(&kind).unwrap();
            assert!(json.contains("\"type\""), "tagged like InputEvent: {json}");
            let back: TargetKind = serde_json::from_str(&json).unwrap();
            assert_eq!(back, kind);
        }
    }

    #[test]
    fn observation_round_trips() {
        let obs = Observation {
            target_id: None,
            timestamp_ms: 1500,
            result: ObservationResult::Text {
                spans: vec![TextSpan {
                    text: "OK".into(),
                    region: Region { x: 0.1, y: 0.2, w: 0.3, h: 0.05 },
                    confidence: 0.97,
                }],
            },
        };
        let back: Observation = serde_json::from_str(&serde_json::to_string(&obs).unwrap()).unwrap();
        assert_eq!(back, obs);
    }

    #[test]
    fn legacy_recording_json_without_targets_loads() {
        let json = r#"{"id":"1","name":"x","events":[],"created_at":1,"playback_speed":1.0}"#;
        let rec: crate::types::Recording = serde_json::from_str(json).unwrap();
        assert!(rec.targets.is_empty());
    }
}
```

- [ ] **Step 2: Run to verify failure.** `cd src-tauri && cargo test perception` → FAIL (module/types don't exist).

- [ ] **Step 3: Implement `perception/mod.rs`:**

```rust
//! Multi-modal perception layer: extract structured observations (text,
//! template matches, color samples) from screen frames. Spec:
//! docs/superpowers/specs/2026-06-28-perception-layer-design.md

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Modality {
    Visual,
    // Audio reserved for a later spec.
}

/// Resolution-independent box; all fields normalized [0,1], top-left origin.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Region {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "PascalCase")]
pub enum TargetKind {
    /// OCR the region; `expect` is an optional text to match (used by later conditionals).
    TextOcr { expect: Option<String> },
    /// `image` is a data-dir-relative PNG path; `source_px` the dimensions of
    /// the source frame it was cropped from (drives ratio scaling at eval time).
    TemplateMatch { image: String, threshold: f32, source_px: [u32; 2] },
    /// `tolerance` = max per-channel absolute diff on the 0–255 scale.
    ColorSample { rgb: [u8; 3], tolerance: f32 },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Target {
    pub id: String,
    pub name: String,
    pub modality: Modality,
    pub region: Option<Region>, // Some for visual; None reserved for audio
    pub kind: TargetKind,
    pub created_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TextSpan {
    pub text: String,
    pub region: Region,
    pub confidence: f32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "PascalCase")]
pub enum ObservationResult {
    Text { spans: Vec<TextSpan> },
    Template { matched: bool, location: Option<Region>, score: f32 },
    Color { rgb: [u8; 3], matched: bool },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Observation {
    /// None = ad-hoc / continuous full-frame.
    pub target_id: Option<String>,
    /// Video-relative ms (same origin as encoder PTS / input events).
    pub timestamp_ms: i64,
    pub result: ObservationResult,
}
```

Add `mod perception;` to `lib.rs` (alphabetical, after `mod playback;`). In `types.rs`, add to `Recording`:

```rust
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub targets: Vec<crate::perception::Target>,
```

Fix every `Recording { … }` struct literal by adding `targets: Vec::new(),` — known sites: `lib.rs` `save_recording`, `recordings_store.rs` test helper `rec()`. `cargo build` finds any others.

- [ ] **Step 4: Run.** `cargo test` → all pass (including pre-existing store tests).

- [ ] **Step 5: Mirror in `src/types.ts`** (append; `Recording` gains optional field):

```ts
export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type TargetKind =
  | { type: "TextOcr"; expect?: string | null }
  | { type: "TemplateMatch"; image: string; threshold: number; source_px: [number, number] }
  | { type: "ColorSample"; rgb: [number, number, number]; tolerance: number };

export interface PerceptionTarget {
  id: string;
  name: string;
  modality: "visual";
  region?: Region | null;
  kind: TargetKind;
  created_at: number;
}

export interface TextSpan {
  text: string;
  region: Region;
  confidence: number;
}

export type ObservationResult =
  | { type: "Text"; spans: TextSpan[] }
  | { type: "Template"; matched: boolean; location?: Region | null; score: number }
  | { type: "Color"; rgb: [number, number, number]; matched: boolean };

export interface Observation {
  target_id?: string | null;
  timestamp_ms: number;
  result: ObservationResult;
}
```

And in `Recording`: `targets?: PerceptionTarget[];`. Run `pnpm typecheck`.

- [ ] **Step 6: Commit** (include the spec + this plan, currently untracked):

```bash
git add docs/superpowers/specs/2026-06-28-perception-layer-design.md docs/superpowers/plans/2026-07-03-perception-layer.md src-tauri/src/perception/mod.rs src-tauri/src/lib.rs src-tauri/src/types.rs src-tauri/src/recordings_store.rs src/types.ts
git commit -m "feat(perception): data model for targets and observations"
```

---

### Task 2: Store — observations sidecar, targets storage, cleanup

**Files:**
- Modify: `src-tauri/src/recordings_store.rs`, `src-tauri/src/lib.rs` (setup sweep call)
- Test: `#[cfg(test)]` in `recordings_store.rs`

**Interfaces:**
- Consumes: `perception::{Observation, Target}` (Task 1).
- Produces on `RecordingsStore`: `write_observations(&self, id: &str, obs: &[Observation]) -> Result<(), StoreError>`, `load_observations(&self, id: &str) -> Result<Vec<Observation>, StoreError>` (missing/corrupt → `Ok(vec![])` with warn, mirroring `load_all`), `add_target(&self, id: &str, target: Target) -> Result<Recording, StoreError>` (replaces same-id target), `remove_target(&self, id: &str, target_id: &str) -> Result<Recording, StoreError>` (also best-effort deletes template PNG), `targets_dir(&self, id: &str) -> PathBuf`, `template_path(&self, id: &str, target_id: &str) -> PathBuf`, `sweep_orphan_perception(&self)`.

- [ ] **Step 1: Write failing tests** (add to existing `mod tests`):

```rust
#[test]
fn observations_sidecar_round_trips_and_missing_reads_empty() {
    use crate::perception::{Observation, ObservationResult};
    let dir = tempdir().unwrap();
    let store = RecordingsStore::open_at(dir.path().to_path_buf());
    assert!(store.load_observations("none").unwrap().is_empty());
    let obs = vec![Observation {
        target_id: None,
        timestamp_ms: 500,
        result: ObservationResult::Color { rgb: [1, 2, 3], matched: true },
    }];
    store.write_observations("1", &obs).unwrap();
    assert_eq!(store.load_observations("1").unwrap(), obs);
}

#[test]
fn add_and_remove_target_update_recording() {
    use crate::perception::{Modality, Region, Target, TargetKind};
    let dir = tempdir().unwrap();
    let store = RecordingsStore::open_at(dir.path().to_path_buf());
    store.add(rec("1", "x")).unwrap();
    let t = Target {
        id: "t1".into(),
        name: "Submit".into(),
        modality: Modality::Visual,
        region: Some(Region { x: 0.1, y: 0.1, w: 0.2, h: 0.1 }),
        kind: TargetKind::TextOcr { expect: None },
        created_at: 1,
    };
    let updated = store.add_target("1", t.clone()).unwrap();
    assert_eq!(updated.targets.len(), 1);
    // Same id replaces, not duplicates.
    let updated = store.add_target("1", t.clone()).unwrap();
    assert_eq!(updated.targets.len(), 1);
    let updated = store.remove_target("1", "t1").unwrap();
    assert!(updated.targets.is_empty());
    assert!(matches!(store.remove_target("1", "t1"), Err(StoreError::NotFound)));
}

#[test]
fn delete_removes_sidecar_and_targets_dir() {
    let dir = tempdir().unwrap();
    let store = RecordingsStore::open_at(dir.path().to_path_buf());
    store.add(rec("1", "x")).unwrap();
    store.write_observations("1", &[]).unwrap();
    std::fs::create_dir_all(store.targets_dir("1")).unwrap();
    std::fs::write(store.template_path("1", "t1"), b"png").unwrap();
    store.delete("1").unwrap();
    assert!(!dir.path().join("observations/1.json").exists());
    assert!(!store.targets_dir("1").exists());
}

#[test]
fn sweep_orphan_perception_prunes_unknown_ids_only() {
    let dir = tempdir().unwrap();
    let store = RecordingsStore::open_at(dir.path().to_path_buf());
    store.add(rec("keep", "x")).unwrap();
    store.write_observations("keep", &[]).unwrap();
    store.write_observations("orphan", &[]).unwrap();
    std::fs::create_dir_all(store.targets_dir("keep")).unwrap();
    std::fs::create_dir_all(store.targets_dir("orphan")).unwrap();
    store.sweep_orphan_perception();
    assert!(dir.path().join("observations/keep.json").exists());
    assert!(!dir.path().join("observations/orphan.json").exists());
    assert!(store.targets_dir("keep").exists());
    assert!(!store.targets_dir("orphan").exists());
}
```

- [ ] **Step 2: Run.** `cargo test recordings_store` → FAIL (methods missing).

- [ ] **Step 3: Implement.** Constants `OBSERVATIONS_DIRNAME: &str = "observations"`, `TARGETS_DIRNAME: &str = "targets"`. Path helpers next to `video_path`:

```rust
fn observations_path(&self, id: &str) -> PathBuf {
    self.data_dir.join(OBSERVATIONS_DIRNAME).join(format!("{}.json", id))
}
pub fn targets_dir(&self, id: &str) -> PathBuf {
    self.data_dir.join(TARGETS_DIRNAME).join(id)
}
pub fn template_path(&self, id: &str, target_id: &str) -> PathBuf {
    self.targets_dir(id).join(format!("{}.png", target_id))
}
```

`write_observations`: `create_dir_all` parent, `serde_json::to_string`, `atomic_write`. `load_observations`: missing → `Ok(Vec::new())`; parse failure → `log_warn("recordings_store", "observations_json_unreadable", …)` + `Ok(Vec::new())`. `add_target`/`remove_target`: load_all → find by id (`NotFound` if recording or, for remove, target missing) → `retain`/push → `write_all` → return clone; `remove_target` ends with `let _ = std::fs::remove_file(self.template_path(id, target_id));`. In `delete`, after the video removal: `let _ = std::fs::remove_file(self.observations_path(id)); let _ = std::fs::remove_dir_all(self.targets_dir(id));`. `sweep_orphan_perception`: collect known ids (like `sweep_orphan_videos`); remove `observations/*.json` whose stem is unknown and `targets/*` dirs whose name is unknown. In `lib.rs` setup, next to the existing sweep: `store.sweep_orphan_perception();`.

- [ ] **Step 4: Run.** `cargo test` → PASS. `cargo fmt --all && cargo clippy`.

- [ ] **Step 5: Commit.** `git add -A src-tauri/src && git commit -m "feat(perception): observations sidecar, target storage, cleanup"`

---

### Task 3: Extractor trait, region mapping, conversion, ColorSampler

**Files:**
- Create: `src-tauri/src/perception/extractor.rs`, `src-tauri/src/perception/convert.rs`
- Modify: `src-tauri/src/perception/mod.rs` (`pub mod extractor; pub mod convert;`)

**Interfaces (Produces):**
- `pub trait Extractor { fn extract(&self, frame: &render_core::decode::RgbaFrame, region: &Region) -> ObservationResult; }`
- `pub fn region_to_pixels(region: &Region, w: u32, h: u32) -> (u32, u32, u32, u32)` — clamped `(x0, y0, cw, ch)`, ≥1×1 on non-empty frames.
- `pub fn crop_frame(frame: &RgbaFrame, region: &Region) -> RgbaFrame`
- `pub fn vision_box_to_region(bx: f32, by: f32, bw: f32, bh: f32, crop: &Region) -> Region` — Vision bottom-left → top-left flip, then crop→frame composition.
- `pub struct ColorSampler { pub rgb: [u8; 3], pub tolerance: f32 }` implementing `Extractor`.
- `convert::bgra_to_rgba(width: u32, height: u32, bgra: &[u8]) -> RgbaFrame`

- [ ] **Step 1: Failing tests** in `extractor.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use render_core::decode::RgbaFrame;

    fn solid(w: u32, h: u32, rgba: [u8; 4]) -> RgbaFrame {
        RgbaFrame { width: w, height: h, data: rgba.iter().copied().cycle().take((w * h * 4) as usize).collect() }
    }

    #[test]
    fn region_to_pixels_round_trips_and_clamps() {
        let r = Region { x: 0.25, y: 0.5, w: 0.5, h: 0.25 };
        assert_eq!(region_to_pixels(&r, 100, 200), (25, 100, 50, 50)); // non-square aspect
        let wild = Region { x: -1.0, y: 0.9, w: 5.0, h: 5.0 };
        let (x0, y0, cw, ch) = region_to_pixels(&wild, 10, 10);
        assert!(x0 == 0 && y0 == 9 && x0 + cw <= 10 && y0 + ch <= 10 && cw >= 1 && ch >= 1);
        let tiny = Region { x: 0.5, y: 0.5, w: 0.0, h: 0.0 };
        let (_, _, cw, ch) = region_to_pixels(&tiny, 10, 10);
        assert!(cw >= 1 && ch >= 1, "degenerate region still samples one pixel");
        assert_eq!(region_to_pixels(&r, 0, 0), (0, 0, 0, 0));
    }

    #[test]
    fn crop_frame_extracts_expected_pixels() {
        let mut f = solid(4, 4, [0, 0, 0, 255]);
        // Paint pixel (2,1) red.
        let i = ((1 * 4 + 2) * 4) as usize;
        f.data[i] = 255;
        let c = crop_frame(&f, &Region { x: 0.5, y: 0.25, w: 0.25, h: 0.25 });
        assert_eq!((c.width, c.height), (1, 1));
        assert_eq!(&c.data[0..3], &[255, 0, 0]);
    }

    #[test]
    fn vision_box_flips_y_and_composes_into_frame_coords() {
        // A box at the crop's bottom-left, in a crop occupying the frame's top-right quadrant.
        let crop = Region { x: 0.5, y: 0.0, w: 0.5, h: 0.5 };
        let r = vision_box_to_region(0.0, 0.0, 0.5, 0.2, &crop);
        assert!((r.x - 0.5).abs() < 1e-6);
        assert!((r.y - (0.0 + 0.8 * 0.5)).abs() < 1e-6, "bottom of crop = y 0.8 within crop");
        assert!((r.w - 0.25).abs() < 1e-6 && (r.h - 0.1).abs() < 1e-6);
    }

    #[test]
    fn color_sampler_matches_within_and_at_tolerance_only() {
        let f = solid(8, 8, [100, 150, 200, 255]);
        let region = Region { x: 0.0, y: 0.0, w: 1.0, h: 1.0 };
        let at = ColorSampler { rgb: [110, 150, 200], tolerance: 10.0 }.extract(&f, &region);
        let over = ColorSampler { rgb: [111, 150, 200], tolerance: 10.0 }.extract(&f, &region);
        match (at, over) {
            (ObservationResult::Color { rgb, matched: true }, ObservationResult::Color { matched: false, .. }) => {
                assert_eq!(rgb, [100, 150, 200]);
            }
            other => panic!("boundary must be inclusive: {other:?}"),
        }
    }
}
```

And in `convert.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bgra_to_rgba_swaps_channels() {
        let f = bgra_to_rgba(1, 1, &[10, 20, 30, 255]); // B,G,R,A
        assert_eq!(f.data, vec![30, 20, 10, 255]);
        assert_eq!((f.width, f.height), (1, 1));
    }
}
```

- [ ] **Step 2: Run.** `cargo test perception` → FAIL.

- [ ] **Step 3: Implement.** `extractor.rs`:

```rust
//! Extractor seam. All extractors consume RGBA8 frames (top-left origin);
//! sources are responsible for converting into this pixel order (convert.rs).

use render_core::decode::RgbaFrame;

use super::{ObservationResult, Region};

pub trait Extractor {
    fn extract(&self, frame: &RgbaFrame, region: &Region) -> ObservationResult;
}

pub fn region_to_pixels(region: &Region, w: u32, h: u32) -> (u32, u32, u32, u32) {
    if w == 0 || h == 0 {
        return (0, 0, 0, 0);
    }
    let c = |v: f32| v.clamp(0.0, 1.0);
    let x0 = ((c(region.x) * w as f32).floor() as u32).min(w - 1);
    let y0 = ((c(region.y) * h as f32).floor() as u32).min(h - 1);
    let x1 = ((c(region.x + region.w) * w as f32).ceil() as u32).clamp(x0 + 1, w);
    let y1 = ((c(region.y + region.h) * h as f32).ceil() as u32).clamp(y0 + 1, h);
    (x0, y0, x1 - x0, y1 - y0)
}

pub fn crop_frame(frame: &RgbaFrame, region: &Region) -> RgbaFrame {
    let (x0, y0, cw, ch) = region_to_pixels(region, frame.width, frame.height);
    let mut data = Vec::with_capacity((cw * ch * 4) as usize);
    for y in y0..y0 + ch {
        let start = ((y * frame.width + x0) * 4) as usize;
        data.extend_from_slice(&frame.data[start..start + (cw * 4) as usize]);
    }
    RgbaFrame { width: cw, height: ch, data }
}

/// Vision reports boxes normalized to the *crop*, origin bottom-left.
/// Flip to top-left and compose into full-frame normalized coordinates.
pub fn vision_box_to_region(bx: f32, by: f32, bw: f32, bh: f32, crop: &Region) -> Region {
    let top_left_y = 1.0 - by - bh;
    Region {
        x: crop.x + bx * crop.w,
        y: crop.y + top_left_y * crop.h,
        w: bw * crop.w,
        h: bh * crop.h,
    }
}

pub struct ColorSampler {
    pub rgb: [u8; 3],
    pub tolerance: f32,
}

impl Extractor for ColorSampler {
    fn extract(&self, frame: &RgbaFrame, region: &Region) -> ObservationResult {
        let (x0, y0, cw, ch) = region_to_pixels(region, frame.width, frame.height);
        if cw == 0 || ch == 0 {
            return ObservationResult::Color { rgb: [0, 0, 0], matched: false };
        }
        let (mut r, mut g, mut b) = (0u64, 0u64, 0u64);
        for y in y0..y0 + ch {
            for x in x0..x0 + cw {
                let i = ((y * frame.width + x) * 4) as usize;
                r += frame.data[i] as u64;
                g += frame.data[i + 1] as u64;
                b += frame.data[i + 2] as u64;
            }
        }
        let n = cw as u64 * ch as u64;
        let avg = [(r / n) as u8, (g / n) as u8, (b / n) as u8];
        let max_diff = avg
            .iter()
            .zip(self.rgb.iter())
            .map(|(a, e)| (*a as f32 - *e as f32).abs())
            .fold(0.0f32, f32::max);
        ObservationResult::Color { rgb: avg, matched: max_diff <= self.tolerance }
    }
}
```

`convert.rs`:

```rust
//! BGRA (scap's native order) → RGBA (the extractor pixel-order canon).

use render_core::decode::RgbaFrame;

pub fn bgra_to_rgba(width: u32, height: u32, bgra: &[u8]) -> RgbaFrame {
    let mut data = vec![0u8; (width * height * 4) as usize];
    for (dst, src) in data.chunks_exact_mut(4).zip(bgra.chunks_exact(4)) {
        dst[0] = src[2];
        dst[1] = src[1];
        dst[2] = src[0];
        dst[3] = src[3];
    }
    RgbaFrame { width, height, data }
}
```

- [ ] **Step 4: Run.** `cargo test` → PASS. fmt + clippy.

- [ ] **Step 5: Commit.** `git commit -am "feat(perception): extractor trait, region mapping, color sampler"`

---

### Task 4: PNG I/O + TemplateMatcher (NCC with ratio scaling)

**Files:**
- Create: `src-tauri/src/perception/png_io.rs`, `src-tauri/src/perception/template.rs`
- Modify: `src-tauri/src/perception/mod.rs` (add mods), `src-tauri/Cargo.toml` (add `png = "0.17"` to main `[dependencies]`)

**Interfaces (Produces):**
- `png_io::encode_png(frame: &RgbaFrame) -> Vec<u8>`, `png_io::write_png(path: &Path, frame: &RgbaFrame) -> Result<(), String>`, `png_io::read_png(path: &Path) -> Result<RgbaFrame, String>` (8-bit RGB/RGBA inputs; RGB expands to RGBA).
- `template::TemplateMatcher { pub template: RgbaFrame, pub threshold: f32, pub source_px: [u32; 2] }` implementing `Extractor`. Match location is normalized to the **full frame**.

- [ ] **Step 1: Failing tests.** `png_io.rs`: encode a 3×2 gradient `RgbaFrame` → `write_png` to a tempdir → `read_png` → assert width/height/data equal. `template.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::perception::{ObservationResult, Region};
    use render_core::decode::RgbaFrame;

    /// Black frame with a white w×h block at (x, y).
    fn frame_with_block(fw: u32, fh: u32, x: u32, y: u32, w: u32, h: u32) -> RgbaFrame {
        let mut data = vec![0u8; (fw * fh * 4) as usize];
        for py in y..y + h {
            for px in x..x + w {
                let i = ((py * fw + px) * 4) as usize;
                data[i..i + 4].copy_from_slice(&[255, 255, 255, 255]);
            }
        }
        RgbaFrame { width: fw, height: fh, data }
    }

    #[test]
    fn planted_template_found_at_location_with_high_score() {
        let frame = frame_with_block(16, 16, 8, 4, 4, 4);
        let tpl = frame_with_block(4, 4, 0, 0, 4, 4); // all-white 4×4… degenerate: add a black pixel
        let mut tpl = tpl;
        tpl.data[0..4].copy_from_slice(&[0, 0, 0, 255]);
        let mut frame = frame;
        let i = ((4 * 16 + 8) * 4) as usize;
        frame.data[i..i + 4].copy_from_slice(&[0, 0, 0, 255]);
        let m = TemplateMatcher { template: tpl, threshold: 0.9, source_px: [16, 16] };
        match m.extract(&frame, &Region { x: 0.0, y: 0.0, w: 1.0, h: 1.0 }) {
            ObservationResult::Template { matched: true, location: Some(loc), score } => {
                assert!(score > 0.99, "score {score}");
                assert!((loc.x - 0.5).abs() < 0.04 && (loc.y - 0.25).abs() < 0.04, "{loc:?}");
            }
            other => panic!("expected match: {other:?}"),
        }
    }

    #[test]
    fn near_miss_scores_below_threshold() {
        let frame = frame_with_block(16, 16, 0, 0, 0, 0); // all black
        let mut tpl = frame_with_block(4, 4, 0, 0, 2, 2); // checker-ish
        tpl.data[60..64].copy_from_slice(&[255, 255, 255, 255]);
        let m = TemplateMatcher { template: tpl, threshold: 0.8, source_px: [16, 16] };
        match m.extract(&frame, &Region { x: 0.0, y: 0.0, w: 1.0, h: 1.0 }) {
            ObservationResult::Template { matched, .. } => assert!(!matched),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn template_recorded_at_double_resolution_still_matches_after_ratio_scaling() {
        // Frame is 16×16; the template was cropped from a 32×32 source (2×),
        // so it is 8×8 but must be evaluated at 4×4.
        let frame = frame_with_block(16, 16, 8, 4, 4, 4);
        let tpl = frame_with_block(8, 8, 0, 0, 8, 8);
        let mut tpl = tpl;
        tpl.data[0..4].copy_from_slice(&[0, 0, 0, 255]);
        let mut frame = frame;
        let i = ((4 * 16 + 8) * 4) as usize;
        frame.data[i..i + 4].copy_from_slice(&[0, 0, 0, 255]);
        let m = TemplateMatcher { template: tpl, threshold: 0.6, source_px: [32, 32] };
        match m.extract(&frame, &Region { x: 0.0, y: 0.0, w: 1.0, h: 1.0 }) {
            ObservationResult::Template { matched, location, score } => {
                assert!(matched, "score {score} loc {location:?}");
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn template_larger_than_region_reports_unmatched_zero_score() {
        let frame = frame_with_block(8, 8, 0, 0, 2, 2);
        let tpl = frame_with_block(6, 6, 0, 0, 2, 2);
        let m = TemplateMatcher { template: tpl, threshold: 0.5, source_px: [8, 8] };
        match m.extract(&frame, &Region { x: 0.0, y: 0.0, w: 0.25, h: 0.25 }) {
            ObservationResult::Template { matched: false, location: None, score } => {
                assert_eq!(score, 0.0);
            }
            other => panic!("{other:?}"),
        }
    }
}
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement.** `png_io.rs` with the `png` crate (`Encoder::new(writer, w, h)`, `set_color(png::ColorType::Rgba)`, `set_depth(png::BitDepth::Eight)`; decode via `png::Decoder`, expand RGB→RGBA). `template.rs` — grayscale NCC:

```rust
use render_core::decode::RgbaFrame;

use super::extractor::{region_to_pixels, Extractor};
use super::{ObservationResult, Region};

pub struct TemplateMatcher {
    pub template: RgbaFrame,
    pub threshold: f32,
    /// Dimensions of the source frame the template was cropped from.
    pub source_px: [u32; 2],
}

fn to_luma(f: &RgbaFrame) -> Vec<f32> {
    f.data
        .chunks_exact(4)
        .map(|p| 0.299 * p[0] as f32 + 0.587 * p[1] as f32 + 0.114 * p[2] as f32)
        .collect()
}

fn resize_nearest(src: &[f32], sw: u32, sh: u32, dw: u32, dh: u32) -> Vec<f32> {
    let mut out = Vec::with_capacity((dw * dh) as usize);
    for y in 0..dh {
        let sy = (y as u64 * sh as u64 / dh as u64).min(sh as u64 - 1) as u32;
        for x in 0..dw {
            let sx = (x as u64 * sw as u64 / dw as u64).min(sw as u64 - 1) as u32;
            out.push(src[(sy * sw + sx) as usize]);
        }
    }
    out
}

impl Extractor for TemplateMatcher {
    fn extract(&self, frame: &RgbaFrame, region: &Region) -> ObservationResult {
        let none = |score: f32| ObservationResult::Template { matched: false, location: None, score };
        let (x0, y0, cw, ch) = region_to_pixels(region, frame.width, frame.height);
        if cw == 0 || ch == 0 || self.template.width == 0 || self.template.height == 0 {
            return none(0.0);
        }
        // Scale the template by the ratio of the evaluated frame to its source frame.
        let tw = ((self.template.width as f32 * frame.width as f32
            / self.source_px[0].max(1) as f32)
            .round() as u32)
            .max(1);
        let th = ((self.template.height as f32 * frame.height as f32
            / self.source_px[1].max(1) as f32)
            .round() as u32)
            .max(1);
        if tw > cw || th > ch {
            return none(0.0);
        }
        let hay = to_luma(frame);
        let tpl_full = to_luma(&self.template);
        let tpl = resize_nearest(&tpl_full, self.template.width, self.template.height, tw, th);

        let n = (tw * th) as f32;
        let t_mean = tpl.iter().sum::<f32>() / n;
        let t_dev: Vec<f32> = tpl.iter().map(|v| v - t_mean).collect();
        let t_var: f32 = t_dev.iter().map(|v| v * v).sum();

        let mut best = (f32::MIN, 0u32, 0u32);
        for oy in 0..=(ch - th) {
            for ox in 0..=(cw - tw) {
                let (mut sum, mut sum_sq, mut cross) = (0.0f32, 0.0f32, 0.0f32);
                for ty in 0..th {
                    for tx in 0..tw {
                        let v = hay[((y0 + oy + ty) * frame.width + x0 + ox + tx) as usize];
                        sum += v;
                        sum_sq += v * v;
                        cross += v * t_dev[(ty * tw + tx) as usize];
                    }
                }
                let w_var = sum_sq - sum * sum / n;
                let den = (w_var * t_var).sqrt();
                let score = if den > 1e-6 { cross / den } else { 0.0 };
                if score > best.0 {
                    best = (score, ox, oy);
                }
            }
        }
        let (score, bx, by) = best;
        let location = Region {
            x: (x0 + bx) as f32 / frame.width as f32,
            y: (y0 + by) as f32 / frame.height as f32,
            w: tw as f32 / frame.width as f32,
            h: th as f32 / frame.height as f32,
        };
        ObservationResult::Template { matched: score >= self.threshold, location: Some(location), score }
    }
}
```

Note: O(region × template) brute force is deliberate v1 — regions are expected small; multi-scale/feature search is spec-deferred.

- [ ] **Step 4: Run.** `cargo test` → PASS. fmt + clippy.

- [ ] **Step 5: Commit.** `git commit -am "feat(perception): template matcher with NCC and png io"`

---

### Task 5: PerceptionSource — recording + live frame access

**Files:**
- Create: `src-tauri/src/perception/source.rs`
- Modify: `src-tauri/src/perception/mod.rs` (`pub mod source;`)

**Interfaces (Produces):**
- `pub trait PerceptionSource { fn frame_at(&mut self, timestamp_ms: i64) -> Result<RgbaFrame, String>; fn dimensions(&self) -> (u32, u32); }` — named `PerceptionSource` (render-core already exports an index-based `FrameSource`).
- `pub fn frame_index_for_ms(timestamp_ms: i64, fps: u32, frame_count: usize) -> usize`
- `pub struct RecordingSource` with `pub fn open(path: &Path, fps: u32) -> Result<Self, String>` (wraps `render_core::decode::Mp4FrameSource`).
- `pub struct LiveSource;` — `frame_at` ignores the timestamp, does a one-shot scap grab, converts BGRA→RGBA. On Windows returns `Err("live-capture-unsupported")`.

- [ ] **Step 1: Failing tests** (mapping is the CI-testable core):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_index_rounds_and_clamps() {
        assert_eq!(frame_index_for_ms(0, 30, 100), 0);
        assert_eq!(frame_index_for_ms(33, 30, 100), 1);   // 0.99 → round 1
        assert_eq!(frame_index_for_ms(50, 30, 100), 2);   // 1.5 → round 2 (round half up)
        assert_eq!(frame_index_for_ms(1_000, 30, 100), 30);
        assert_eq!(frame_index_for_ms(999_999, 30, 100), 99); // clamp to last frame
        assert_eq!(frame_index_for_ms(-5, 30, 100), 0);
        assert_eq!(frame_index_for_ms(100, 0, 100), 0);   // fps guard
        assert_eq!(frame_index_for_ms(100, 30, 0), 0);    // empty guard
    }
}
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement:**

```rust
//! Frame access for perception. Named PerceptionSource — render-core already
//! has an index-based `FrameSource`; this one is timestamp-based.

use std::path::Path;

use render_core::decode::{FrameSource as _, Mp4FrameSource, RgbaFrame};

pub trait PerceptionSource {
    /// One frame as RGBA8. Live sources ignore `timestamp_ms` (grab "now").
    fn frame_at(&mut self, timestamp_ms: i64) -> Result<RgbaFrame, String>;
    fn dimensions(&self) -> (u32, u32);
}

/// CFR mapping: the encoder holds cadence via `repeat_last`, so
/// `round(ms × fps / 1000)` clamped to the last frame is exact. If encoding
/// ever becomes VFR this must switch to per-sample PTS.
pub fn frame_index_for_ms(timestamp_ms: i64, fps: u32, frame_count: usize) -> usize {
    if frame_count == 0 || fps == 0 {
        return 0;
    }
    let idx = ((timestamp_ms.max(0) * fps as i64 + 500) / 1000) as usize;
    idx.min(frame_count - 1)
}

pub struct RecordingSource {
    src: Mp4FrameSource,
    fps: u32,
}

impl RecordingSource {
    pub fn open(path: &Path, fps: u32) -> Result<Self, String> {
        Ok(Self { src: Mp4FrameSource::open(path).map_err(|e| e.to_string())?, fps })
    }
}

impl PerceptionSource for RecordingSource {
    fn frame_at(&mut self, timestamp_ms: i64) -> Result<RgbaFrame, String> {
        let idx = frame_index_for_ms(timestamp_ms, self.fps, self.src.frame_count());
        self.src.decode_frame(idx).map_err(|e| e.to_string())
    }
    fn dimensions(&self) -> (u32, u32) {
        self.src.dimensions()
    }
}
```

`LiveSource` (below the trait, mirroring `capture.rs`'s acquisition pattern — build `Capturer` with `Options { fps: 1, show_cursor: true, output_type: FrameType::BGRAFrame, output_resolution: Resolution::Captured, .. }`, `start_capture()`, poll `get_next_frame()` up to 60 attempts skipping empty/idle frames, `stop_capture()`, convert with `convert::bgra_to_rgba`):

```rust
pub struct LiveSource {
    dims: (u32, u32),
}

impl LiveSource {
    pub fn new() -> Self {
        Self { dims: (0, 0) }
    }
}

#[cfg(target_os = "windows")]
impl PerceptionSource for LiveSource {
    fn frame_at(&mut self, _timestamp_ms: i64) -> Result<RgbaFrame, String> {
        Err("live-capture-unsupported".to_string())
    }
    fn dimensions(&self) -> (u32, u32) {
        self.dims
    }
}

#[cfg(not(target_os = "windows"))]
impl PerceptionSource for LiveSource {
    fn frame_at(&mut self, _timestamp_ms: i64) -> Result<RgbaFrame, String> {
        use scap::capturer::{Capturer, Options, Resolution};
        use scap::frame::{Frame as ScapFrame, FrameType};
        if !scap::is_supported() || !scap::has_permission() {
            return Err("permission-denied".to_string());
        }
        let opts = Options {
            fps: 1,
            show_cursor: true,
            show_highlight: false,
            output_type: FrameType::BGRAFrame,
            output_resolution: Resolution::Captured,
            ..Default::default()
        };
        let mut capturer = Capturer::build(opts).map_err(|e| format!("{e:?}"))?;
        capturer.start_capture();
        let mut result = Err("no frame delivered".to_string());
        for _ in 0..60 {
            match capturer.get_next_frame() {
                Ok(ScapFrame::BGRA(f)) if f.width > 0 && !f.data.is_empty() => {
                    let (w, h) = (f.width as u32, f.height as u32);
                    self.dims = (w, h);
                    result = Ok(super::convert::bgra_to_rgba(w, h, &f.data));
                    break;
                }
                Ok(_) => continue, // idle/audio frame
                Err(e) => {
                    result = Err(format!("{e:?}"));
                    break;
                }
            }
        }
        capturer.stop_capture();
        result
    }
    fn dimensions(&self) -> (u32, u32) {
        self.dims
    }
}
```

- [ ] **Step 4: Run.** `cargo test` → PASS (LiveSource is compile-checked; it's exercised manually via the Studio "Test live" button in Task 10). fmt + clippy.

- [ ] **Step 5: Commit.** `git commit -am "feat(perception): timestamp-based sources for recordings and live screen"`

---

### Task 6: Tauri commands — extract_region, save_target, delete_target, load_observations

**Files:**
- Create: `src-tauri/src/perception/commands.rs`
- Modify: `src-tauri/src/perception/mod.rs` (`pub mod commands;`), `src-tauri/src/lib.rs` (register 4 commands)

**Interfaces:**
- Consumes: store methods (Task 2), extractors (Tasks 3–4), sources (Task 5).
- Produces:
  - `#[tauri::command] extract_region(app, source: ExtractSource, region: Region, kind: TargetKind, trace_id) -> Result<ObservationResult, String>`
  - `#[tauri::command] save_target(app, recording_id: String, target: Target, timestamp_ms: Option<i64>, trace_id) -> Result<Recording, String>` — for `TemplateMatch`, backend decodes the frame at `timestamp_ms`, crops `target.region`, writes the PNG, and overwrites `image`/`source_px` authoritatively.
  - `#[tauri::command] delete_target(app, recording_id: String, target_id: String, trace_id) -> Result<Recording, String>`
  - `#[tauri::command] load_observations(app, recording_id: String, trace_id) -> Result<Vec<Observation>, String>`
  - `pub enum ExtractSource` — `#[serde(tag = "type", rename_all = "PascalCase")]`: `Live`, `Recording { recording_id: String, timestamp_ms: i64 }`.
  - Helper `fn build_extractor(app, kind: &TargetKind) -> Result<Box<dyn Extractor>, String>` — `TextOcr` returns `Err("ocr-not-yet-wired")` until Task 7 replaces it.

- [ ] **Step 1: Failing test** — the one pure seam worth locking now, template path resolution + eval flow. Add to `commands.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::perception::{ObservationResult, Region, TargetKind};
    use render_core::decode::RgbaFrame;

    #[test]
    fn evaluate_runs_extractor_against_source_frame() {
        struct OneFrame(RgbaFrame);
        impl crate::perception::source::PerceptionSource for OneFrame {
            fn frame_at(&mut self, _ts: i64) -> Result<RgbaFrame, String> {
                Ok(self.0.clone())
            }
            fn dimensions(&self) -> (u32, u32) {
                (self.0.width, self.0.height)
            }
        }
        let frame = RgbaFrame { width: 2, height: 2, data: vec![9, 9, 9, 255].repeat(4) };
        let mut src = OneFrame(frame);
        let kind = TargetKind::ColorSample { rgb: [9, 9, 9], tolerance: 0.0 };
        let region = Region { x: 0.0, y: 0.0, w: 1.0, h: 1.0 };
        let result = evaluate(&mut src, 0, &region, extractor_for_test(&kind)).unwrap();
        assert!(matches!(result, ObservationResult::Color { matched: true, .. }));
    }
}
```

(`RgbaFrame` needs `Clone` — if render-core's `RgbaFrame` lacks it, add `#[derive(Clone)]` there; it's a plain data struct.)

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement.** Core seam, testable without Tauri:

```rust
pub fn evaluate(
    source: &mut dyn PerceptionSource,
    timestamp_ms: i64,
    region: &Region,
    extractor: Box<dyn Extractor>,
) -> Result<ObservationResult, String> {
    let frame = source.frame_at(timestamp_ms)?;
    Ok(extractor.extract(&frame, region))
}
```

(`extractor_for_test` in the test module just builds `Box::new(ColorSampler { … })` from the kind.) Command bodies are thin dispatchers in the house style — every command wraps `observability::trace_command("<name>", trace_id, Some(json!({ "recordingId": … })), || { … })`:

- `extract_region`: match `source` — `Live` → `LiveSource::new()`; `Recording { recording_id, timestamp_ms }` → load recording via store, `video` metadata required (`ok_or("recording has no video")`), `RecordingSource::open(Path::new(&video.path), video.fps)`. Build extractor from `kind`: `ColorSample` → `ColorSampler`; `TemplateMatch` → `png_io::read_png(&data_dir.join(&image))` (the stored `image` is data-dir-relative) → `TemplateMatcher`; `TextOcr` → `Err("ocr-not-yet-wired")`. Then `evaluate(…)`.
- `save_target`: open store; if `target.kind` is `TemplateMatch`, require `timestamp_ms` and `target.region` (else `Err`), open `RecordingSource`, `frame_at`, `crop_frame`, `write_png(store.template_path(...))`, then rewrite the kind with `image: format!("targets/{}/{}.png", recording_id, target.id)` and `source_px: [frame.width, frame.height]`; finally `store.add_target(...)`.
- `delete_target` → `store.remove_target(...)`; `load_observations` → `store.load_observations(...)`.

Register all four in `lib.rs` `generate_handler!` (add `perception::commands::extract_region,` etc. after `studio_export::studio_export,`).

- [ ] **Step 4: Run.** `cargo test` → PASS; `cargo build` confirms command registration compiles. fmt + clippy.

- [ ] **Step 5: Commit.** `git commit -am "feat(perception): extract/save/delete/load tauri commands"`

---

### Task 7: TextOcr via macOS Vision + CI coverage exclusion

**Files:**
- Create: `src-tauri/src/perception/ocr_macos.rs` (macOS-only, coverage-excluded)
- Modify: `src-tauri/src/perception/mod.rs` (`#[cfg(target_os = "macos")] pub mod ocr_macos;`), `perception/extractor.rs` (add `VisionOcr`), `perception/commands.rs` (wire `TextOcr` kind), `src-tauri/Cargo.toml`, `.github/workflows/test.yml`

**Interfaces:**
- Consumes: `crop_frame`, `vision_box_to_region`, `png_io::encode_png`.
- Produces: `ocr_macos::recognize(png: &[u8], fast: bool) -> Result<Vec<RecognizedSpan>, String>` where `pub struct RecognizedSpan { pub text: String, pub confidence: f32, pub bbox: [f32; 4] }` (bbox = Vision-normalized `[x, y, w, h]`, bottom-left origin, crop-relative). `extractor::VisionOcr { pub fast: bool }` implementing `Extractor` (macOS: calls `recognize`, maps boxes via `vision_box_to_region`, logs + returns empty spans on error; non-macOS: `VisionOcr` is not defined — the commands layer keeps returning an error for `TextOcr` off-macOS).

- [ ] **Step 1: Failing test.** The Vision call itself is not CI-testable; the mapping already is (Task 3). Add the wiring test with a fake in `extractor.rs`:

```rust
#[test]
fn extractor_trait_object_dispatch_works_for_ocr_shape() {
    // Fake OCR extractor standing in for VisionOcr (mirrors how playback
    // hides rdev behind a simulator trait): returns one span covering the crop.
    struct FakeOcr;
    impl Extractor for FakeOcr {
        fn extract(&self, _f: &RgbaFrame, region: &Region) -> ObservationResult {
            ObservationResult::Text {
                spans: vec![TextSpan { text: "hi".into(), region: *region, confidence: 1.0 }],
            }
        }
    }
    let f = solid(2, 2, [0, 0, 0, 255]);
    let boxed: Box<dyn Extractor> = Box::new(FakeOcr);
    match boxed.extract(&f, &Region { x: 0.0, y: 0.0, w: 1.0, h: 1.0 }) {
        ObservationResult::Text { spans } => assert_eq!(spans[0].text, "hi"),
        other => panic!("{other:?}"),
    }
}
```

(import `TextSpan` in the test module).

- [ ] **Step 2: Run** → FAIL (import churn only) → fix imports → PASS. Now the real work:

- [ ] **Step 3: Add the dependency** under `[target.'cfg(target_os = "macos")'.dependencies]`:

```toml
objc2-vision = { version = "0.3", features = ["VNRequest", "VNRequestHandler", "VNRecognizeTextRequest", "VNObservation", "VNTypes"] }
```

Feature names follow objc2's header-file convention; if `cargo build` reports an unknown feature, use the names it suggests (the compiler error lists available features).

- [ ] **Step 4: Implement `ocr_macos.rs`:**

```rust
//! macOS Vision OCR. Kept behind the Extractor seam; this file is excluded
//! from the coverage gate (not CI-testable) and verified manually via the
//! Studio "Test" buttons.

use objc2::rc::Retained;
use objc2::AnyThread;
use objc2_foundation::{NSArray, NSData, NSDictionary};
use objc2_vision::{
    VNImageRequestHandler, VNRecognizeTextRequest, VNRequest, VNRequestTextRecognitionLevel,
};

pub struct RecognizedSpan {
    pub text: String,
    pub confidence: f32,
    /// Vision-normalized [x, y, w, h], bottom-left origin, crop-relative.
    pub bbox: [f32; 4],
}

pub fn recognize(png: &[u8], fast: bool) -> Result<Vec<RecognizedSpan>, String> {
    unsafe {
        let data = NSData::with_bytes(png);
        let handler = VNImageRequestHandler::initWithData_options(
            VNImageRequestHandler::alloc(),
            &data,
            &NSDictionary::new(),
        );
        let request = VNRecognizeTextRequest::new();
        request.setRecognitionLevel(if fast {
            VNRequestTextRecognitionLevel::Fast
        } else {
            VNRequestTextRecognitionLevel::Accurate
        });
        let requests = NSArray::from_retained_slice(&[Retained::into_super(
            Retained::into_super(request.clone()),
        )]);
        handler
            .performRequests_error(&requests)
            .map_err(|e| e.to_string())?;
        let Some(results) = request.results() else {
            return Ok(Vec::new());
        };
        let mut spans = Vec::new();
        for obs in results.iter() {
            let Some(candidate) = obs.topCandidates(1).firstObject() else {
                continue;
            };
            let rect = obs.boundingBox();
            spans.push(RecognizedSpan {
                text: candidate.string().to_string(),
                confidence: candidate.confidence(),
                bbox: [
                    rect.origin.x as f32,
                    rect.origin.y as f32,
                    rect.size.width as f32,
                    rect.size.height as f32,
                ],
            });
        }
        Ok(spans)
    }
}
```

objc2-vision 0.3's exact method spellings (`initWithData_options`, `performRequests_error`, `from_retained_slice` upcasting) may differ slightly — resolve against the crate docs/compiler; the function signature (`recognize(png, fast) -> Result<Vec<RecognizedSpan>, String>`) is the contract and must not change. In `extractor.rs`:

```rust
#[cfg(target_os = "macos")]
pub struct VisionOcr {
    pub fast: bool,
}

#[cfg(target_os = "macos")]
impl Extractor for VisionOcr {
    fn extract(&self, frame: &RgbaFrame, region: &Region) -> ObservationResult {
        let crop = crop_frame(frame, region);
        let png = super::png_io::encode_png(&crop);
        match super::ocr_macos::recognize(&png, self.fast) {
            Ok(items) => ObservationResult::Text {
                spans: items
                    .into_iter()
                    .map(|s| super::TextSpan {
                        text: s.text,
                        confidence: s.confidence,
                        region: vision_box_to_region(s.bbox[0], s.bbox[1], s.bbox[2], s.bbox[3], region),
                    })
                    .collect(),
            },
            Err(e) => {
                crate::observability::log_warn("perception", "ocr_failed", &e, None);
                ObservationResult::Text { spans: Vec::new() }
            }
        }
    }
}
```

In `commands.rs` `build_extractor`, replace the `TextOcr` arm: macOS → `Ok(Box::new(VisionOcr { fast: false }))` (on-demand uses accurate); other platforms → `Err("ocr-unavailable-on-this-platform")` (use `#[cfg]` blocks).

- [ ] **Step 5: CI exclusion.** In `.github/workflows/test.yml` line ~177, change the regex:

```
--ignore-filename-regex '(permissions|ocr_macos)\.rs$'
```

- [ ] **Step 6: Verify.** `cargo build && cargo test && cargo clippy` on macOS. Manual smoke: deferred to Task 10's Test button (that's the UI for it) — do NOT skip it there.

- [ ] **Step 7: Commit.** `git commit -am "feat(perception): macos vision ocr behind the extractor seam"`

---

### Task 8: Frontend — video rect math + PerceptionOverlay

**Files:**
- Create: `src/lib/video-rect.ts`, `src/lib/video-rect.test.ts`, `src/components/studio/PerceptionOverlay.tsx`, `src/components/studio/PerceptionOverlay.test.tsx`
- Modify: `src/components/studio/StudioPlayer.tsx`, `src/components/studio/StudioEditor.tsx`

**Interfaces (Produces):**
- `videoDisplayRect(container: { width: number; height: number }, video: { width: number; height: number }): { left: number; top: number; width: number; height: number }` — contain-fit rect of the displayed video inside its container.
- `<PerceptionOverlay rect={Rect} targets={PerceptionTarget[]} spans={TextSpan[]} />` — absolutely positioned layer; target rects (indigo, labeled) and OCR span boxes (sky-blue, thin).
- `StudioPlayer` gains props `targets?: PerceptionTarget[]`, `spans?: TextSpan[]`; it tracks the video's displayed rect (intrinsic dims from `onLoadedMetadata`, container size via `ResizeObserver`) and renders the overlay. `StudioEditor` passes `selected.targets ?? []`.

- [ ] **Step 1: Failing tests.** `video-rect.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { videoDisplayRect } from "./video-rect";

describe("videoDisplayRect", () => {
  it("letterboxes a wide video in a tall container", () => {
    const r = videoDisplayRect({ width: 100, height: 200 }, { width: 1920, height: 1080 });
    expect(r.width).toBeCloseTo(100);
    expect(r.height).toBeCloseTo(56.25);
    expect(r.left).toBeCloseTo(0);
    expect(r.top).toBeCloseTo((200 - 56.25) / 2);
  });

  it("pillarboxes a tall video in a wide container", () => {
    const r = videoDisplayRect({ width: 200, height: 100 }, { width: 1080, height: 1920 });
    expect(r.height).toBeCloseTo(100);
    expect(r.left).toBeCloseTo((200 - 56.25) / 2);
  });

  it("returns a zero rect on degenerate input", () => {
    expect(videoDisplayRect({ width: 0, height: 0 }, { width: 1920, height: 1080 })).toEqual({
      left: 0,
      top: 0,
      width: 0,
      height: 0,
    });
  });
});
```

`PerceptionOverlay.test.tsx` — render with `rect={{ left: 10, top: 20, width: 200, height: 100 }}` and one target with `region { x: 0.25, y: 0.5, w: 0.5, h: 0.25 }` → assert the target box's inline style is `left: 50px; top: 50px; width: 100px; height: 25px` (via `getByText` on the target name → parent element style), and a span box renders per TextSpan.

- [ ] **Step 2: Run.** `pnpm vitest run src/lib/video-rect.test.ts src/components/studio/PerceptionOverlay.test.tsx` → FAIL.

- [ ] **Step 3: Implement.** `video-rect.ts`:

```ts
/** Contain-fit rect of a video's displayed pixels inside a container box. */
export function videoDisplayRect(
  container: { width: number; height: number },
  video: { width: number; height: number },
): { left: number; top: number; width: number; height: number } {
  if (container.width <= 0 || container.height <= 0 || video.width <= 0 || video.height <= 0) {
    return { left: 0, top: 0, width: 0, height: 0 };
  }
  const scale = Math.min(container.width / video.width, container.height / video.height);
  const width = video.width * scale;
  const height = video.height * scale;
  return { left: (container.width - width) / 2, top: (container.height - height) / 2, width, height };
}
```

`PerceptionOverlay.tsx` — pure presentational; the layer itself sits at `position: "absolute"` with `left/top/width/height` from `rect`, `pointerEvents: "none"`; each target box `position: "absolute"`, `left: ${region.x * rect.width}px` (px, not %, so tests assert exact numbers), `border: "1.5px solid #6366f1"`, label chip on top-left; span boxes `border: "1px solid #38bdf8"`. In `StudioPlayer`: wrap the existing `<video>` container contents; add `const containerRef`, `const [intrinsic, setIntrinsic]` (set in the existing `onLoadedMetadata` from `v.videoWidth/videoHeight`), `const [box, setBox]` via a `ResizeObserver` on the container div; `const rect = videoDisplayRect(box, intrinsic)`; render `<PerceptionOverlay rect={rect} targets={targets ?? []} spans={spans ?? []} />` as a sibling after `<video>`. In `StudioEditor`, pass `targets={selected.targets ?? []}`.

- [ ] **Step 4: Run tests** → PASS. `pnpm typecheck && pnpm lint:fix`.

- [ ] **Step 5: Commit.** `git commit -am "feat(studio): perception overlay with contain-fit rect mapping"`

---

### Task 9: Drag-to-select + CreateTargetPopover

**Files:**
- Create: `src/components/studio/CreateTargetPopover.tsx`, `src/components/studio/CreateTargetPopover.test.tsx`
- Modify: `src/components/studio/StudioPlayer.tsx` (+ its test), `src/components/studio/StudioEditor.tsx`

**Interfaces:**
- `StudioPlayer` new props: `onSaveTarget?: (target: PerceptionTarget, timestampMs: number) => Promise<void>`, `onSampleColor?: (region: Region, timestampMs: number) => Promise<[number, number, number]>`.
- `<CreateTargetPopover region anchor={{ x, y }} onSave={(name, kind) => void} onCancel />` — kind picker (Text / Image / Color) + name input; defaults: `TextOcr { expect: null }`, `TemplateMatch { image: "", threshold: 0.8, source_px: [0, 0] }` (backend overwrites), `ColorSample { rgb: [0,0,0], tolerance: 10 }` (rgb filled by sampling).
- `StudioEditor` implements the two callbacks with `invoke("save_target", …)` / `invoke("extract_region", …)` and updates `recordings` state from the returned `Recording`.

- [ ] **Step 1: Failing tests.**
  - `StudioPlayer.test.tsx` (follow the existing mock setup — `getBoundingClientRect`/pointer-capture stubs like `StudioTimeline.test.tsx`, and the existing mock of `@/lib/observability`): pointer down at (30, 20) → move to (60, 45) → up on the overlay interaction layer calls nothing yet but shows the popover; choosing "Color" then Save calls `onSampleColor` with a region ≈ `{ x: 0.3, y: 0.4, w: 0.3, h: 0.5 }` given a mocked 100×50 video rect at origin — assert each field with `toBeCloseTo`. A pointer down+up *without* movement must still toggle play (existing behavior — assert video paused state flips, or that no popover appears).
  - `CreateTargetPopover.test.tsx`: renders three kind buttons; Save with kind "Text" calls `onSave("Target 1", { type: "TextOcr", expect: null })`.

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement.** In `StudioPlayer`, replace the overlay from Task 8 with an interaction layer (same geometry, `pointerEvents: "auto"`) handling:

```ts
const dragRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);
const [selection, setSelection] = useState<Region | null>(null);
const [popover, setPopover] = useState<{ region: Region; x: number; y: number } | null>(null);

const norm = (e: React.PointerEvent, el: HTMLElement) => {
  const r = el.getBoundingClientRect();
  return {
    x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
    y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
  };
};
```

Down: capture pointer, record start, `videoRef.current?.pause()`. Move: past a 4px threshold set `moved`, update `selection` (min/abs box of start→current). Up: if `!moved` → `togglePlay()` (click keeps play/pause); else `setPopover({ region: selection, x: e.clientX, y: e.clientY })`. Popover Save: build the target —

```ts
const target: PerceptionTarget = {
  id: crypto.randomUUID(),
  name,
  modality: "visual",
  region,
  kind,
  created_at: Date.now(),
};
const tsMs = Math.round(current * 1000);
if (kind.type === "ColorSample" && onSampleColor) {
  kind.rgb = await onSampleColor(region, tsMs);
}
await onSaveTarget?.(target, tsMs);
```

then clear selection/popover. `CreateTargetPopover` is a small fixed-position card (dark theme matching `sp-*` styles): name input (default `Target ${n}` via a `defaultName` prop), three buttons Text/Image/Color (selected state), optional "expect" text input when Text is selected, Save/Cancel. In `StudioEditor`:

```ts
const handleSaveTarget = useCallback(
  async (target: PerceptionTarget, timestampMs: number) => {
    if (!selectedId) return;
    const updated = await invoke<Recording>("save_target", {
      recordingId: selectedId,
      target,
      timestampMs,
    });
    setRecordings((rs) => rs.map((r) => (r.id === updated.id ? updated : r)));
  },
  [selectedId],
);

const handleSampleColor = useCallback(
  async (region: Region, timestampMs: number): Promise<[number, number, number]> => {
    const res = await invoke<ObservationResult>("extract_region", {
      source: { type: "Recording", recording_id: selectedId, timestamp_ms: timestampMs },
      region,
      kind: { type: "ColorSample", rgb: [0, 0, 0], tolerance: 255 },
    });
    return res.type === "Color" ? res.rgb : [0, 0, 0];
  },
  [selectedId],
);
```

(wrap in try/catch with `logEvent("error", "studio.perception", …)` like the neighboring handlers).

- [ ] **Step 4: Run tests** → PASS. `pnpm typecheck && pnpm lint:fix`.

- [ ] **Step 5: Commit.** `git commit -am "feat(studio): drag-to-select target authoring"`

---

### Task 10: PerceptionPanel — target list, Test on frame / live, delete

**Files:**
- Create: `src/components/studio/PerceptionPanel.tsx`, `src/components/studio/PerceptionPanel.test.tsx`
- Modify: `src/components/studio/StudioEditor.tsx`

**Interfaces:**
- `<PerceptionPanel recordingId targets playheadMs onRecordingUpdate={(rec: Recording) => void} />` — renders one row per target (name, kind label); actions per row: **Test frame** (`extract_region` with `{ type: "Recording", recording_id, timestamp_ms: playheadMs }`), **Test live** (`{ type: "Live" }`), **✕ delete** (`delete_target`, then `onRecordingUpdate`). Inline result per row: Text → joined span texts (or "no text found"); Template → `match 0.93` / `no match 0.41`; Color → swatch + rgb + match/no-match. Uses `invoke` from `@/lib/observability` directly (tests mock that module).
- Rendered by `StudioEditor` in the bottom panel between the controls host and the timeline, only when `selected.targets?.length`.

- [ ] **Step 1: Failing test.** Mock `@/lib/observability`'s `invoke`; render with two targets; click "Test frame" on a `ColorSample` target → assert `invoke` called with `("extract_region", { source: { type: "Recording", recording_id: "1", timestamp_ms: 1234 }, region: target.region, kind: target.kind })` and the resolved `{ type: "Color", rgb: [1,2,3], matched: true }` renders "match". Click delete → `invoke("delete_target", { recordingId: "1", targetId: "t1" })` and `onRecordingUpdate` called with the resolved recording.

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement** (compact dark-theme rows consistent with `tl-*`/`sp-*` styling; keep a `results: Record<string, ObservationResult | "error">` state; a target with no region is untestable → disable buttons). Wire into `StudioEditor` under the `controlsHost` div:

```tsx
{selected.targets && selected.targets.length > 0 && (
  <PerceptionPanel
    recordingId={selected.id}
    targets={selected.targets}
    playheadMs={sync.videoTimeMs}
    onRecordingUpdate={(rec) => setRecordings((rs) => rs.map((r) => (r.id === rec.id ? rec : r)))}
  />
)}
```

- [ ] **Step 4: Run tests** → PASS. `pnpm typecheck && pnpm lint:fix`.

- [ ] **Step 5: Manual verification (required — this is the Vision smoke test).** `pnpm tauri dev` → open Studio → pick a recording with video → drag a box over visible text → create a Text target → **Test frame** shows recognized text with boxes overlaid; **Test live** OCRs the live screen. Create an Image and a Color target; Test both. Fix what doesn't work before committing.

- [ ] **Step 6: Commit.** `git commit -am "feat(studio): perception panel with test-on-frame and test-live"`

---

### Task 11: Settings — perception.continuous_ocr (off by default)

**Files:**
- Modify: `src-tauri/src/types.rs`, `src-tauri/src/settings.rs` (log field), `src/types.ts`, `src/components/SettingsTab.tsx`
- Test: `settings.rs` tests

**Interfaces (Produces):** `PerceptionSettings { pub continuous_ocr: bool }` (`Default` = `false`); `AppSettings` gains `#[serde(default)] pub perception: PerceptionSettings`. TS: `PerceptionSettings { continuous_ocr: boolean }`, `AppSettings.perception`.

- [ ] **Step 1: Failing tests** in `settings.rs`:

```rust
#[test]
fn perception_defaults_off_and_missing_field_deserializes_off() {
    assert!(!AppSettings::default().perception.continuous_ocr);
    let s: AppSettings = serde_json::from_str("{}").unwrap();
    assert!(!s.perception.continuous_ocr);
    let s: AppSettings =
        serde_json::from_str(r#"{"perception":{"continuous_ocr":true}}"#).unwrap();
    assert!(s.perception.continuous_ocr);
}
```

- [ ] **Step 2: Run** → FAIL. **Implement** in `types.rs`:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PerceptionSettings {
    /// Continuous full-frame OCR during recording. Off by default: it
    /// transcribes everything visible on screen into a plaintext sidecar.
    #[serde(default)]
    pub continuous_ocr: bool,
}
```

and add the field to `AppSettings`. In `settings.rs` `save_settings`, add `"continuousOcr": settings.perception.continuous_ocr` to the log fields. Run → PASS.

- [ ] **Step 3: Frontend.** `types.ts`: add `PerceptionSettings` + `perception: PerceptionSettings` on `AppSettings`. `SettingsTab.tsx`: new `Section` (icon `<Eye />` from lucide) after Capture, one `st-row` switch exactly in the "System audio" pattern:

```tsx
{/* Perception */}
<Section icon={<Eye />} label="Perception">
  <div className="st-panel">
    {settings ? (
      <div className="st-row">
        <div className="st-row-main">
          <span className="st-row-label">Continuous text scan while recording</span>
          <span className="st-row-desc">
            OCRs the screen ~1×/sec during recording to build a searchable text timeline.
            Stored as plain text with the recording — leave off if you record sensitive
            content.
          </span>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={settings.perception.continuous_ocr}
          aria-label="Continuous text scan while recording"
          className={`st-switch${settings.perception.continuous_ocr ? " on" : ""}`}
          onClick={() =>
            update({
              ...settings,
              perception: { continuous_ocr: !settings.perception.continuous_ocr },
            })
          }
        >
          <span className="st-knob" />
        </button>
      </div>
    ) : (
      <div className="st-row">
        <span className="st-row-desc">Loading…</span>
      </div>
    )}
  </div>
</Section>
```

Check `useAppSettings` (`src/hooks/useAppSettings.ts`) — if it constructs a default settings object, add the `perception` default there too.

- [ ] **Step 4:** `cargo test && pnpm typecheck && pnpm lint:fix`.

- [ ] **Step 5: Commit.** `git commit -am "feat(perception): opt-in continuous ocr setting"`

---

### Task 12: Capture tee + SampleGate + continuous worker + flush

**Files:**
- Create: `src-tauri/src/perception/gate.rs`, `src-tauri/src/perception/worker.rs`
- Modify: `src-tauri/src/perception/mod.rs` (mods), `src-tauri/src/capture.rs`, `src-tauri/src/recording_session.rs`, `src-tauri/src/lib.rs` (start/stop wiring), `src-tauri/src/perception/extractor.rs` (`continuous_extractor()`)

**Interfaces:**
- `gate::SAMPLE_INTERVAL_MS: i64 = 750` (~1.3 fps, inside the spec's 1–2 fps band); `SampleGate::new(interval_ms: i64)`, `fn due(&mut self, now_ms: i64) -> bool` — first call true, then rate-limited.
- `capture::CaptureConfig` gains `pub tee: Option<std::sync::mpsc::SyncSender<Frame>>` (existing public `Frame` struct). In the **acquisition** loop, gate first, clone only when due, `try_send`, drop on full — before the encoder `try_send`, never blocking it.
- `worker::PerceptionWorker::spawn(rx: Receiver<Frame>, start_ms: i64, extractor: Box<dyn Extractor + Send>) -> PerceptionWorker`; `fn finish(self) -> Vec<Observation>` (joins after the sender side drops). Observations: `target_id: None`, `timestamp_ms = frame.timestamp_ms - start_ms`, full-frame region; converts via `convert::bgra_to_rgba`; logs per-frame duration at debug and a warn if a frame errors (skip, continue).
- `extractor::continuous_extractor() -> Option<Box<dyn Extractor + Send>>` — macOS: `Some(Box::new(VisionOcr { fast: true }))` (fast level for the continuous pass); other platforms: `None` (no worker spawned).
- `RecordingSession::start(id, capture, perception: Option<PerceptionWorker>)`; `StoppedSession` gains `pub perception: Option<PerceptionWorker>`.

- [ ] **Step 1: Failing tests.** `gate.rs`:

```rust
#[test]
fn gate_passes_first_then_rate_limits() {
    let mut g = SampleGate::new(750);
    assert!(g.due(1_000));
    assert!(!g.due(1_500));
    assert!(!g.due(1_749));
    assert!(g.due(1_750));
    assert!(g.due(10_000));
}
```

`worker.rs` (fake extractor + real channel — no fake clock needed since the gate lives in capture):

```rust
#[test]
fn worker_converts_stamps_video_relative_and_finishes_on_disconnect() {
    use crate::capture::Frame;
    struct CountSpans;
    impl Extractor for CountSpans {
        fn extract(&self, f: &RgbaFrame, _r: &Region) -> ObservationResult {
            // Prove BGRA→RGBA happened: input BGRA [1,2,3,255] → RGBA red channel 3.
            ObservationResult::Color { rgb: [f.data[0], f.data[1], f.data[2]], matched: true }
        }
    }
    let (tx, rx) = std::sync::mpsc::sync_channel::<Frame>(4);
    let worker = PerceptionWorker::spawn(rx, 1_000, Box::new(CountSpans));
    tx.send(Frame { width: 1, height: 1, data: vec![1, 2, 3, 255], timestamp_ms: 1_500 }).unwrap();
    tx.send(Frame { width: 1, height: 1, data: vec![1, 2, 3, 255], timestamp_ms: 2_250 }).unwrap();
    drop(tx);
    let obs = worker.finish();
    assert_eq!(obs.len(), 2);
    assert_eq!(obs[0].timestamp_ms, 500);
    assert_eq!(obs[1].timestamp_ms, 1_250);
    assert!(obs.iter().all(|o| o.target_id.is_none()));
    match &obs[0].result {
        ObservationResult::Color { rgb, .. } => assert_eq!(*rgb, [3, 2, 1]),
        other => panic!("{other:?}"),
    }
}
```

Session: update every existing `start(id, capture)` call/test to `start(id, capture, None)` and assert a `StoppedSession.perception` pass-through in one test.

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement.** `gate.rs`:

```rust
pub const SAMPLE_INTERVAL_MS: i64 = 750;

pub struct SampleGate {
    interval_ms: i64,
    last: Option<i64>,
}

impl SampleGate {
    pub fn new(interval_ms: i64) -> Self {
        Self { interval_ms, last: None }
    }
    pub fn due(&mut self, now_ms: i64) -> bool {
        match self.last {
            Some(t) if now_ms - t < self.interval_ms => false,
            _ => {
                self.last = Some(now_ms);
                true
            }
        }
    }
}
```

`worker.rs`:

```rust
pub struct PerceptionWorker {
    handle: std::thread::JoinHandle<Vec<Observation>>,
}

impl PerceptionWorker {
    pub fn spawn(
        rx: std::sync::mpsc::Receiver<crate::capture::Frame>,
        start_ms: i64,
        extractor: Box<dyn Extractor + Send>,
    ) -> Self {
        let handle = std::thread::spawn(move || {
            let full = Region { x: 0.0, y: 0.0, w: 1.0, h: 1.0 };
            let mut out = Vec::new();
            while let Ok(frame) = rx.recv() {
                let started = std::time::Instant::now();
                let rgba = crate::perception::convert::bgra_to_rgba(frame.width, frame.height, &frame.data);
                let result = extractor.extract(&rgba, &full);
                crate::observability::log_info(
                    "perception",
                    "continuous_sample",
                    Some(serde_json::json!({
                        "durationMs": started.elapsed().as_secs_f64() * 1000.0,
                        "timestampMs": frame.timestamp_ms - start_ms,
                    })),
                );
                out.push(Observation {
                    target_id: None,
                    timestamp_ms: frame.timestamp_ms - start_ms,
                    result,
                });
            }
            out
        });
        Self { handle }
    }

    /// Call AFTER capture has stopped (sender dropped) so the loop exits.
    pub fn finish(self) -> Vec<Observation> {
        self.handle.join().unwrap_or_default()
    }
}
```

`capture.rs` — `CaptureConfig` gains `pub tee: Option<mpsc::SyncSender<Frame>>` (update the two `CaptureConfig` construction sites: `lib.rs` and none else). In `start`, `let tee = config.tee;` and move it into the acquisition thread. Inside the acquisition loop, in the `Ok(ScapFrame::BGRA(f))` arm **before** building `CapturedFrame` (clone only when due — the frame data buffer is 25–50 MB at retina res):

```rust
let ts = Utc::now().timestamp_millis();
if let Some(tee) = &tee {
    if gate.due(ts) {
        // Sampled copy for the perception worker; drop on backpressure —
        // this must NEVER block or slow the encoder path.
        let _ = tee.try_send(Frame {
            width: f.width as u32,
            height: f.height as u32,
            data: f.data.clone(),
            timestamp_ms: ts,
        });
    }
}
```

with `let mut gate = crate::perception::gate::SampleGate::new(crate::perception::gate::SAMPLE_INTERVAL_MS);` declared before the loop, and the existing `CapturedFrame { …, ts }` reusing the same `ts`. `recording_session.rs` — `Active`/`StoppedSession` gain `perception: Option<crate::perception::worker::PerceptionWorker>`; `start` takes it as third arg. `lib.rs` `start_recording`:

```rust
// Perception tee: opt-in continuous OCR (macOS-only extractor for now).
let mut tee = None;
let mut perception_rx = None;
if settings.perception.continuous_ocr && crate::perception::extractor::continuous_extractor().is_some() {
    let (tx, rx) = std::sync::mpsc::sync_channel::<crate::capture::Frame>(1);
    tee = Some(tx);
    perception_rx = Some(rx);
}
```

Pass `tee` into `CaptureConfig`. After capture starts, spawn the worker only if capture actually started (`capture.as_ref()`):

```rust
let perception = match (&capture, perception_rx) {
    (Some(cap), Some(rx)) => crate::perception::extractor::continuous_extractor()
        .map(|ex| crate::perception::worker::PerceptionWorker::spawn(rx, cap.start_ms(), ex)),
    _ => None,
};
state.session.start(id.clone(), capture, perception).map_err(|e| e.to_string())?;
```

`stop_recording`, after the capture `stop()` block (sender is dropped once the acquisition thread exits):

```rust
if let Some(worker) = stopped.perception {
    let observations = worker.finish();
    if !observations.is_empty() {
        if let Ok(store) = recordings_store::RecordingsStore::open(&app) {
            if let Err(e) = store.write_observations(&stopped.id, &observations) {
                observability::log_warn("perception", "observations_flush_failed", &e.to_string(), None);
            }
        }
    }
}
```

(An unsaved recording's sidecar becomes an orphan; `sweep_orphan_perception` collects it next launch.)

- [ ] **Step 4: Run.** `cargo test` → PASS (all session tests updated). fmt + clippy.

- [ ] **Step 5: Perf gate (spec requirement — do not skip).** `pnpm tauri dev`, enable the setting, record ~30 s of a busy screen. Then check the log (`get_diagnostics_snapshot` recent lines or the log file): `continuous_sample` `durationMs` must stay under ~750 ms sustained on this machine. If it doesn't, raise `SAMPLE_INTERVAL_MS` to 1000 and note it in the commit message.

- [ ] **Step 6: Commit.** `git commit -am "feat(perception): rate-gated capture tee and continuous ocr worker"`

---

### Task 13: Perception timeline lane + playhead text overlay

**Files:**
- Modify: `src/components/studio/StudioTimeline.tsx` (+ test), `src/components/studio/StudioEditor.tsx`

**Interfaces:**
- `StudioTimeline` gains `perceptionTicks?: Array<{ ms: number; label: string }>` — when non-empty, renders a third `tl-lane` with ticks (color `#38bdf8`, class `tl-tick`, `title={label}`); clicking a tick calls `onSeekSeconds(ms / 1000)` (stopPropagation so the track's click-seek doesn't double-fire); legend gains a "Text" swatch.
- `StudioEditor`: loads observations on selection (`invoke<Observation[]>("load_observations", { recordingId })`, reset to `[]` on switch/error), builds ticks (`label` = first span text truncated to 40 chars, or span count), and passes `spans` for the observation nearest the playhead (within 600 ms) to `StudioPlayer`.

- [ ] **Step 1: Failing test** in `StudioTimeline.test.tsx`:

```tsx
it("renders perception ticks and seeks on click", () => {
  const onSeek = vi.fn();
  render(
    <StudioTimeline
      {...base}
      onSeekSeconds={onSeek}
      onLoopChange={noop}
      perceptionTicks={[{ ms: 500, label: "Submit" }]}
    />,
  );
  const tick = screen.getByTitle("Submit");
  fireEvent.click(tick);
  expect(onSeek).toHaveBeenCalledWith(0.5);
});
```

- [ ] **Step 2: Run** → FAIL. **Implement** the lane (after the keys lane):

```tsx
{perceptionTicks && perceptionTicks.length > 0 && (
  <div className="tl-lane">
    {perceptionTicks.map((t, i) => (
      <div
        key={`p${i}`}
        className="tl-tick"
        role="button"
        title={t.label}
        style={{ left: `${pctOf(t.ms)}%`, background: "#38bdf8", cursor: "pointer" }}
        onClick={(e) => {
          e.stopPropagation();
          onSeekSeconds(t.ms / 1000);
        }}
        onPointerDown={(e) => e.stopPropagation()}
      />
    ))}
  </div>
)}
```

plus `{ c: "#38bdf8", l: "Text" }` in the legend array (conditional on ticks present is fine). In `StudioEditor`:

```ts
const [observations, setObservations] = useState<Observation[]>([]);
useEffect(() => {
  setObservations([]);
  if (!selectedId) return;
  invoke<Observation[]>("load_observations", { recordingId: selectedId })
    .then(setObservations)
    .catch((e) => logEvent("warn", "studio.perception", "load_observations_failed", { error: e }));
}, [selectedId]);

const perceptionTicks = useMemo(
  () =>
    observations.map((o) => ({
      ms: o.timestamp_ms,
      label:
        o.result.type === "Text" && o.result.spans.length > 0
          ? o.result.spans[0].text.slice(0, 40)
          : "observation",
    })),
  [observations],
);

const playheadSpans = useMemo(() => {
  let best: Observation | null = null;
  for (const o of observations) {
    if (Math.abs(o.timestamp_ms - sync.videoTimeMs) <= 600) {
      if (!best || Math.abs(o.timestamp_ms - sync.videoTimeMs) < Math.abs(best.timestamp_ms - sync.videoTimeMs)) {
        best = o;
      }
    }
  }
  return best?.result.type === "Text" ? best.result.spans : [];
}, [observations, sync.videoTimeMs]);
```

Pass `perceptionTicks` to the timeline and `spans={playheadSpans}` to the player.

- [ ] **Step 3: Run.** `pnpm vitest run src/components/studio` → PASS. `pnpm typecheck && pnpm lint:fix`.

- [ ] **Step 4: End-to-end manual check.** With the setting on: record 20 s scrolling a text-heavy window → stop → save → open Studio → Perception lane shows ticks; clicking one seeks; pausing on it draws text boxes over the frame; drag a box over a word → Text target → Test frame finds it.

- [ ] **Step 5: Commit.** `git commit -am "feat(studio): perception lane and observation review overlay"`

---

## Spec-coverage checklist (self-review)

- Data model + serde defaults → Tasks 1, 11. Storage/sidecar/cleanup → Task 2. Region mapping, pixel canon → Task 3. ColorSample rule → Tasks 3. TemplateMatch + ratio scaling + `source_px` → Task 4. PerceptionSource, CFR mapping, live grab → Task 5. Command surface (incl. backend template crop) → Task 6. Vision OCR, Y-flip, fast/accurate split, coverage exclusion → Task 7 (flip mapping tested in Task 3). Studio drag-to-select (click-vs-drag), overlay on displayed rect → Tasks 8–9. Test affordances (manual Vision smoke) → Task 10. Opt-in setting → Task 11. Tee + throttle + drop-on-backpressure + flush + perf gate → Task 12. Perception lane + review overlay → Task 13.
- Not built (spec-deferred): conditionals, audio, AI similarity, multi-scale search, Windows OCR.
