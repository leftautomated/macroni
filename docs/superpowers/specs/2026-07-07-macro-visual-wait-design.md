# Visual Wait Authoring — Sub-Project D Design

**Program:** Macro graph (see `2026-07-05-macro-graph-runtime-design.md`).
A (runtime), B (canvas), C (visual snip) are complete. **D adds image/color
wait authoring:** drag a box on a recording frame to make a "wait until this
image/color appears" node — reviving the paused perception drag-select
components inside the macro-authoring flow (the intended use for perception,
replacing the shelved standalone annotation UI).

**This completes the macro-graph vision:** segments (C, visual) + text waits
(B) + image/color waits (D), all authored visually on the canvas.

---

## Global Constraints

- **No backend changes.** Reuses existing commands: `save_target` (decodes a
  recording frame at a timestamp, crops the dragged region, writes the
  template PNG under `targets/{recording_id}/`, returns the target with its
  `image` path), `extract_region` (samples a region's average color), and
  `save_macro` (already copies a WaitFor target's template asset into the
  macro's `assets/` on save). A's runtime already evaluates template/color
  waits.
- **Maximal reuse.** The drag-to-select overlay, `CreateTargetPopover`
  (Image/Color options), and the `onSaveTarget`/`onSampleColor` hooks already
  live on `StudioPlayer` (built for perception, currently unused because
  `PERCEPTION_STUDIO_UI=false`). D embeds `StudioPlayer` in the macro
  add-panel and wires those hooks to produce a WaitFor **node** instead of a
  persisted recording annotation.
- **Produced node is a normal WaitFor**, byte-compatible with A/B/C:
  `{ type:"WaitFor", target, timeout_ms:10000, poll_interval_ms:500 }`. The
  `target` is the captured `PerceptionTarget` (TemplateMatch with an `image`
  path for Image; ColorSample with sampled rgb for Color).
- **Template capture side effect is acceptable:** `save_target` persists the
  target on the source recording (and writes the PNG) — that PNG is exactly
  what `save_macro` copies into the macro. The recording gaining a target is
  harmless (its annotation UI is off).
- **`PERCEPTION_STUDIO_UI` stays false** — D does not resurrect the standalone
  annotation overlay/panel; it uses the components directly in the macro
  add-panel context only.
- **macOS-first** (template/color eval and live "Test" are macOS; consistent
  with A). Style/tests: dark theme, double quotes, semicolons; vitest+RTL.

## Design

**`AddNodePanel` gains a third mode: "Add Visual Wait"** (alongside Add
Segment and Add Text Wait). When a recording is selected:
- Render a `StudioPlayer` for that recording's video (reuse
  `useVideoAssetUrl`), scrubbable to the frame the user wants to match.
- Pass `onSaveTarget` and `onSampleColor` handlers (see below). The player's
  existing drag-to-select + `CreateTargetPopover` provide the box + Image/Color
  choice. **Text is NOT offered here** (the dedicated Add Text Wait form owns
  text) — the popover is scoped to Image/Color in this context.
- On a completed authoring, a WaitFor node is built and `onAdd(node)` appends
  it to the working macro doc (same path C/B use).

**Handlers (in `MacroEditor`, passed down):**
- **Image** → `onSaveTarget(target, timestampMs)`: call
  `invoke("save_target", { recordingId, target, timestampMs })` to capture the
  template PNG; the returned `Recording` contains the target with its rewritten
  `image` path; wrap that exact target in a WaitFor node via
  `waitNodeFromTarget` and `onAdd` it.
- **Color** → `onSampleColor(region, timestampMs)`: call
  `invoke("extract_region", { source:{type:"Recording",recording_id,timestamp_ms}, region, kind:{type:"ColorSample",rgb:[0,0,0],tolerance:255} })`,
  read the sampled `rgb`, build a `ColorSample` target, wrap in a WaitFor node,
  `onAdd`. (StudioPlayer's drag flow already calls `onSampleColor` before
  building the color target — reuse that; the color path produces no asset.)

**Pure builder (`src/lib/macro-wait.ts`):**
- `waitNodeFromTarget(target: PerceptionTarget, timeoutMs = 10000): MacroNode`
  → `{ id: crypto.randomUUID(), kind: { type:"WaitFor", target, timeout_ms: timeoutMs, poll_interval_ms: 500 }, x:40, y:280 }`.
- Reuse B's existing text-wait construction by refactoring it to also build
  through `waitNodeFromTarget` (a text `TextOcr` target wrapped the same way),
  so all three wait kinds share one node builder — unit-tested.

## Error handling
- `save_target`/`extract_region` failure → surface in the add-panel (toast/
  inline), no node added. Reuse the editor's existing error banner.
- A recording without video → Visual Wait mode disabled (needs a frame).
- Region-less or zero-size box → popover doesn't open (StudioPlayer's existing
  4px drag threshold handles this).

## Testing
- `macro-wait.ts`: `waitNodeFromTarget` builds the exact WaitFor node for a
  TemplateMatch target, a ColorSample target, and a TextOcr target (shared
  builder) — pure, unit-tested; B's text-wait test still green through the
  shared builder.
- `AddNodePanel`/`MacroEditor`: the Image handler calls `save_target` with the
  right args and adds a WaitFor node with the returned target; the Color
  handler calls `extract_region` and adds a ColorSample WaitFor; Visual Wait
  disabled without video. (Mock `invoke`; `StudioPlayer`'s drag is exercised
  via its existing test stubs, or the player is mocked and the handlers driven
  directly — the node-building logic is the unit under test, not react
  video rendering.)
- Existing AddNodePanel (segment, text-wait) + MacroEditor tests stay green.

## Build order (for the plan)
1. `macro-wait.ts` `waitNodeFromTarget` (shared by text/image/color) + tests;
   refactor B's inline text-wait build to use it (behavior-preserving).
2. "Add Visual Wait" mode in `AddNodePanel` (embed `StudioPlayer`, Image/Color
   handlers → capture via save_target/extract_region → WaitFor node), wired
   through `MacroEditor`; popover scoped to Image/Color; manual smoke (drag a
   box on a frame, add an image wait, run the macro, confirm it waits for that
   image on screen).

## Deferred (post-D)
Branching/loops; run history; a live "Test this wait" affordance in the
add-panel; multi-frame/scale-robust template matching.
