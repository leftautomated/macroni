# Visual Segment Snipping — Sub-Project C Design

**Program:** Macro graph (see `2026-07-05-macro-graph-runtime-design.md`).
A (runtime) and B (canvas) are complete. **C makes segment authoring visual:**
drag a range directly on a recording's event timeline to snip a Segment node,
instead of typing start/end seconds. This delivers the "snip events from the
recording" part of the original vision with a real selection UI.

**Scope boundary:** C covers segment snipping only. Template/color Wait
authoring via on-frame region select (reviving the paused perception
components) is a larger, distinct effort — deferred to sub-project **D**.
Text waits (B) remain the wait-authoring path until then.

---

## Global Constraints

- **No backend changes.** Reuses A's model/commands and B's canvas verbatim.
  Segment nodes are built exactly as B's `AddNodePanel` builds them (filter a
  recording's events to a relative-ms range, embed with `provenance`), only
  the range is now chosen visually.
- **Reuse `StudioTimeline`** as the range selector — its existing
  drag-to-select loop-region gesture (`onLoopChange` → `LoopRegion {a,b}` in
  video-relative ms) IS the snip selection. No new drag code.
- **Visual + numeric stay in sync:** dragging updates the start/end; the
  numeric inputs remain (editable) for precision; editing them reflects on
  the timeline selection. One source of truth (`{startMs, endMs}`).
- **Correct event basis:** the snip range and the event filter use the same
  relative-ms basis B established (`video.start_ms ?? recording.created_at`);
  `Math.round` the ms (integer i64/u64 on the backend).
- **No perception-component revival** (that's D); `PERCEPTION_STUDIO_UI` stays
  false.
- **Style/tests:** dark theme, double quotes, semicolons (biome); vitest+RTL.
  StudioTimeline drag math is already tested; C tests the sync/range→node
  logic, not the timeline's internals.

## Design

**`AddNodePanel` "Add Segment" becomes visual.** When a recording is selected:
- Render a `StudioTimeline` for it (`events`, `durationMs` from the recording's
  video; `startMs` = the relative basis; `videoMs` = a scrub playhead or 0).
- The user drags across the events to select a range → `onLoopChange` gives
  `{a, b}` (ms). That populates `startMs`/`endMs`.
- The existing start/end second inputs stay, two-way bound to the same
  `{startMs, endMs}` state (drag → inputs; input → selection highlight).
- A live summary: "N events · X.Xs selected" (count of events whose relative
  timestamp falls in `[startMs, endMs]`).
- "Add segment" builds the same `MacroNode` B does, from `{startMs, endMs}`.

**State ownership.** `AddNodePanel` holds `{ recordingId, rangeMs: {start,end} }`.
Extract a pure helper `eventsInRange(events, basis, startMs, endMs)` (already
implicit in B's `handleAddSegment`) so both the summary count and the built
node use one function — unit-tested.

**No new node shape, no new command.** The produced Segment node is byte-identical
to B's, so `save_macro`/runtime consume it unchanged.

## Components (`src/components/studio/macros/`)

- `AddNodePanel.tsx` (MODIFY) — replace the numeric-only segment sub-form with
  the timeline-backed range picker (timeline + synced inputs + summary),
  reusing `StudioTimeline`. Keep Add Text Wait unchanged.
- `src/lib/macro-segment.ts` (NEW) — `eventsInRange(events, basis, startMs, endMs): InputEvent[]` and `segmentNodeFromRange(recording, startMs, endMs): MacroNode` — the pure builders B did inline, extracted so C's UI and B's tests share one implementation. `AddNodePanel` calls these.

## Error / edge handling

- Empty selection (drag with no events in range, or start==end) → summary "0
  events", Add disabled.
- Range clamped to `[0, duration]`; end>start enforced (Add disabled otherwise).
- A recording with a huge event count still renders (StudioTimeline already
  virtualizes via its scroll window; no change needed).

## Testing

- `macro-segment.ts`: `eventsInRange` inclusive bounds + basis; `segmentNodeFromRange` builds the exact `MacroNode` shape (kind Segment, filtered events, provenance ms rounded) — mirrors B's existing segment tests, now against the shared helper.
- `AddNodePanel`: dragging a range on the (mocked-geometry) timeline updates the summary count and the built node's events; numeric edit ↔ selection sync; empty range disables Add. (Reuse the getBoundingClientRect + pointer stubs the StudioTimeline tests already use.)
- Existing AddNodePanel/MacroEditor tests stay green (the text-wait path is untouched; the segment path's output node is unchanged).

## Build order (for the plan)

1. `macro-segment.ts` pure builders (`eventsInRange`, `segmentNodeFromRange`) + tests; refactor B's `AddNodePanel.handleAddSegment` to call them (behavior-preserving — existing tests green).
2. Timeline-backed range picker in `AddNodePanel`'s Add Segment form (StudioTimeline + synced `{startMs,endMs}` + live summary), building via `segmentNodeFromRange`; drag-updates-inputs and input-updates-selection; manual smoke (drag a range, see the count, add it, confirm the node on the canvas has those events).

## Deferred to D
Template/color Wait authoring via on-frame region select (revive
PerceptionOverlay/CreateTargetPopover/StudioPlayer drag-select in the
macro-authoring context, producing template/color WaitFor nodes through the
existing `save_target`/`extract_region` backend); branching; run history.
