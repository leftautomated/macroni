# Visual Wait Authoring (Sub-Project D) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Author image/color "wait until this appears" nodes by dragging a box on a recording frame, reusing the existing StudioPlayer drag-select + CreateTargetPopover and the save_target/extract_region/save_macro backend. Spec: `docs/superpowers/specs/2026-07-07-macro-visual-wait-design.md`.

**Architecture:** A shared pure `waitNodeFromTarget` builder wraps any PerceptionTarget (text/image/color) in a WaitFor node. `AddNodePanel` gains an "Add Visual Wait" mode embedding `StudioPlayer` (image/color mode); its `onSaveTarget`/`onSampleColor` hooks, wired through `MacroEditor`, capture the target via existing commands and append a WaitFor node. No backend changes.

**Tech Stack:** React 19, existing `StudioPlayer`/`CreateTargetPopover`/`useVideoAssetUrl`, Tauri `save_target`/`extract_region`, vitest+RTL.

## Global Constraints

- **No backend changes.** `save_target` (captures template PNG on the recording, returns target with `image` path), `extract_region` (samples color), `save_macro` (copies WaitFor template assets) all exist and are tested.
- **Produced node byte-compatible:** `{ type:"WaitFor", target, timeout_ms:10000, poll_interval_ms:500 }`, `id`=uuid.
- **Reuse, don't rebuild:** StudioPlayer already owns drag-select + CreateTargetPopover + `onSaveTarget(target,timestampMs)`/`onSampleColor(region,timestampMs)`. D wires those to build a node, not persist an annotation.
- **Text stays in B's dedicated form**; the embedded player's popover is scoped to Image/Color for this context.
- **`PERCEPTION_STUDIO_UI` stays false** — no annotation-overlay revival, components used directly in the add-panel only.
- **macOS-first** (template/color capture+eval). Recording without video → Visual Wait disabled.
- TS types: `PerceptionTarget`, `Region`, `TargetKind` (`TemplateMatch{image,threshold,source_px}` | `ColorSample{rgb,tolerance}` | `TextOcr{expect}`), `MacroNode`, `Recording`.
- Wire shapes (verified in A): `save_target { recordingId, target, timestampMs }` → `Recording`; `extract_region { source:{type:"Recording",recording_id,timestamp_ms}, region, kind }` → `ObservationResult` (`{type:"Color",rgb,matched}` for a ColorSample probe).
- Checks per task: `pnpm vitest run src`, `pnpm typecheck`, `pnpm lint:fix`.

## File Structure
- `src/lib/macro-wait.ts` (NEW, +test) — `waitNodeFromTarget`.
- `src/components/studio/macros/AddNodePanel.tsx` (MODIFY) — Visual Wait mode; refactor text-wait to use `waitNodeFromTarget`.
- `src/components/studio/macros/MacroEditor.tsx` (MODIFY) — image/color capture handlers passed to AddNodePanel.

---

### Task 1: Shared `waitNodeFromTarget` builder + text-wait refactor

**Files:** Create `src/lib/macro-wait.ts`, `src/lib/macro-wait.test.ts`; Modify `src/components/studio/macros/AddNodePanel.tsx`.

**Interfaces (Produces):**
- `export function waitNodeFromTarget(target: PerceptionTarget, timeoutMs = 10000): MacroNode` → `{ id: crypto.randomUUID(), kind: { type: "WaitFor", target, timeout_ms: timeoutMs, poll_interval_ms: 500 }, x: 40, y: 160 }`.

- [ ] **Step 1: Failing tests** (`macro-wait.test.ts`):

```ts
import { describe, expect, it } from "vitest";
import { waitNodeFromTarget } from "./macro-wait";
import type { PerceptionTarget } from "@/types";

const target = (kind: PerceptionTarget["kind"]): PerceptionTarget => ({
  id: "t1", name: "n", modality: "visual",
  region: { x: 0, y: 0, w: 1, h: 1 }, kind, created_at: 1,
});

describe("waitNodeFromTarget", () => {
  it("wraps a text target with defaults", () => {
    const node = waitNodeFromTarget(target({ type: "TextOcr", expect: "Go" }));
    expect(node.kind.type).toBe("WaitFor");
    if (node.kind.type !== "WaitFor") throw new Error();
    expect(node.kind.timeout_ms).toBe(10000);
    expect(node.kind.poll_interval_ms).toBe(500);
    expect(node.kind.target.kind).toEqual({ type: "TextOcr", expect: "Go" });
  });
  it("wraps a template target and honors a custom timeout", () => {
    const node = waitNodeFromTarget(
      target({ type: "TemplateMatch", image: "assets/x.png", threshold: 0.8, source_px: [10, 10] }),
      8000,
    );
    if (node.kind.type !== "WaitFor") throw new Error();
    expect(node.kind.timeout_ms).toBe(8000);
    expect(node.kind.target.kind.type).toBe("TemplateMatch");
  });
  it("wraps a color target", () => {
    const node = waitNodeFromTarget(target({ type: "ColorSample", rgb: [1, 2, 3], tolerance: 10 }));
    if (node.kind.type !== "WaitFor") throw new Error();
    expect(node.kind.target.kind).toEqual({ type: "ColorSample", rgb: [1, 2, 3], tolerance: 10 });
  });
});
```

- [ ] **Step 2:** `pnpm vitest run src/lib/macro-wait.test.ts` → FAIL.
- [ ] **Step 3: Implement** `macro-wait.ts`. Then refactor `AddNodePanel`'s text-wait handler: build the `TextOcr` `PerceptionTarget` as it does now, then `onAdd(waitNodeFromTarget(target, timeout * 1000))` instead of the inline node literal. Behavior-preserving — the existing text-wait test must stay green (same node shape; the position may change from y:160 which the test shouldn't assert — if it does, update it minimally).
- [ ] **Step 4:** `pnpm vitest run src && pnpm typecheck && pnpm lint:fix` → PASS (existing text-wait test green).
- [ ] **Step 5: Commit** `git add src/lib/macro-wait.ts src/lib/macro-wait.test.ts src/components/studio/macros/AddNodePanel.tsx && git commit -m "feat(macros): shared wait-node builder reused by text waits"`

---

### Task 2: "Add Visual Wait" mode (embedded frame + image/color capture)

**Files:** Modify `src/components/studio/macros/AddNodePanel.tsx` (+test), `src/components/studio/macros/MacroEditor.tsx`.

**Interfaces:**
- `AddNodePanel` gains props: `onCaptureImageWait?: (recordingId: string, target: PerceptionTarget, timestampMs: number) => Promise<void>` and `onCaptureColorWait?: (recordingId: string, region: Region, timestampMs: number) => Promise<void>` — provided by `MacroEditor`. (Or a single `onAddVisualWait` — see Step 3; keep the panel building the node and the editor only doing the invoke. Simplest split below.)
- Recommended split (panel owns node-building; editor owns capture invokes):
  - Panel renders `<StudioPlayer>` for the selected recording with:
    - `onSaveTarget={async (target, tsMs) => { const captured = await captureImage(selectedRecordingId, target, tsMs); onAdd(waitNodeFromTarget(captured)); }}` where `captureImage` is a prop from MacroEditor that calls `save_target` and returns the target with its rewritten `image` path (pulled from the returned Recording's matching node).
    - `onSampleColor={async (region, tsMs) => sampleColor(selectedRecordingId, region, tsMs)}` — a prop calling `extract_region` and returning `[r,g,b]`; StudioPlayer's existing drag flow then builds the ColorSample target and calls `onSaveTarget` with it → the same `onSaveTarget` path wraps it as a WaitFor node (no asset for color, so `captureImage`'s save_target is only needed for TemplateMatch — branch on `target.kind.type`: TemplateMatch → save_target to capture the PNG; ColorSample → no capture, wrap directly).
- `MacroEditor` provides `captureImage`/`sampleColor` (thin `invoke` wrappers with error surfacing via the existing banner) and passes the selected recording + `onAdd` into the panel's Visual Wait mode.
- The player's `CreateTargetPopover` must be scoped to Image/Color here (hide Text). Add an optional `kinds?: KindOption[]` prop to `CreateTargetPopover` (default all three) and pass `["Image","Color"]` from the macro add-panel; StudioPlayer forwards it. (Small, additive change to CreateTargetPopover/StudioPlayer.)

- [ ] **Step 1: Failing tests** (`AddNodePanel.test.tsx`): mock the capture props; simulate the player producing a TemplateMatch target via `onSaveTarget` → assert `onAdd` called with a WaitFor node whose target is the captured one; simulate a ColorSample target via `onSaveTarget` → assert a ColorSample WaitFor node added without an image capture; Visual Wait mode disabled when the recording has no video. (Mock `StudioPlayer` to a stub exposing buttons that invoke the passed `onSaveTarget` with a canned target — the unit under test is the node-building wiring, not video rendering.)
- [ ] **Step 2:** RED.
- [ ] **Step 3: Implement** the Visual Wait mode + MacroEditor handlers + the `kinds` scoping on CreateTargetPopover/StudioPlayer. Image path: `save_target` captures the PNG and returns the target with `image`; wrap via `waitNodeFromTarget`. Color path: wrap the sampled ColorSample target directly. Errors → editor banner, no node added. Keep Add Segment + Add Text Wait unchanged.
- [ ] **Step 4:** `pnpm vitest run src && pnpm typecheck && pnpm lint:fix` → PASS (all prior macro/studio tests green; existing perception-component tests for StudioPlayer/CreateTargetPopover green with the additive `kinds` prop).
- [ ] **Step 5: Manual smoke (controller/user):** `pnpm tauri dev` → Macro editor → create a macro → Add Segment (drag a range) → Add Visual Wait: scrub to a frame, drag a box over a UI element, pick Image → a WaitFor node appears → connect Segment→Wait → Save → Run: the segment replays, the wait node polls until that image is on screen (or times out). Repeat with Color.
- [ ] **Step 6: Commit** `git commit -am "feat(macros): author image and color wait nodes from a frame"`

---

## Spec-coverage checklist (self-review)
- Shared wait builder + text refactor → Task 1. Visual Wait mode (embedded player, image via save_target, color via extract_region, popover scoped to Image/Color) + editor capture handlers → Task 2.
- Type consistency: WaitFor node shape identical to A/B; `waitNodeFromTarget` shared by all three wait kinds; capture uses A's exact `save_target`/`extract_region` wire shapes; produced TemplateMatch target's `image` path is what `save_macro` copies.
- Deferred (absent): branching, run history, in-panel live "Test", multi-scale matching.
