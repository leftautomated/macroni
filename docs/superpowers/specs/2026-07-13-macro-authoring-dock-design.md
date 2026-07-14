# Macro Authoring Dock — Tiled Workspace Design

**Context:** The macro editor's AddNodePanel embeds `StudioTimeline` (Add
Segment) and `StudioPlayer` (Add Visual Wait) inside a sidebar capped at 300px
(`.macro-editor-main` grid `minmax(240px, 300px) 1fr`). Both components were
designed for editor width: the timeline's zoom row wraps and collides, the
legend and two lanes overwhelm the column, the player's transport bar crams,
and "drag to loop a range" is misleading copy in a context that *selects* a
range. The recording select inside "Add Segment" also invisibly gates "Add
Visual Wait" three sections down.

**Direction (user-chosen):** Blender/Figma-style tiled workspace — resizable
regions with drag dividers, no modals. Media authoring moves to a bottom dock
at full canvas width; the sidebar returns to being a forms column.

---

## Global Constraints

- **No backend changes.** All node-building logic is untouched:
  `segmentNodeFromRange`, `eventsInRange`, `segmentBasis`, `waitNodeFromTarget`,
  `captureImageWait` (`save_target`), `sampleColor` (`extract_region`).
- **Reuse `StudioPlayer` and `StudioTimeline` as-is** (plus one copy-label
  prop on the timeline). No compact variants; the dock gives them the width
  they were designed for.
- **Panels via shadcn `resizable`** (`react-resizable-panels`), installed with
  the shadcn CLI per project convention.
- **Form controls unify on shadcn** (`Input`, existing `Select`); panel-local
  `anp-*` CSS stays for layout/labels.

## Layout

`macro-editor-main` becomes nested resizable groups:

```
ResizablePanelGroup direction=horizontal
├─ Panel: sidebar          (default ~280px, min 240px, max ~480px)
├─ ResizableHandle (vertical divider)
└─ Panel:
   ResizablePanelGroup direction=vertical
   ├─ Panel: MacroCanvas
   ├─ ResizableHandle (horizontal divider)  ─ only when dock open
   └─ Panel: AuthoringDock (collapsed/absent until a recording is selected)
```

- The dock renders only when a recording with video is selected; the canvas
  otherwise keeps 100% height (no dead strip, no handle).
- Dock default height ≈ 40% of the pane, user-resizable; sizes are not
  persisted (YAGNI — add `autoSaveId` later if wanted).

## AuthoringDock (new component)

Full-width horizontal split inside the dock: `StudioPlayer` (left, ~55%) and
`StudioTimeline` (right), mirroring the main studio pairing.

- **Player:** wired to the selected recording via `useVideoAssetUrl`; keeps
  its own transport controls inline. `onSaveTarget`/`onSampleColor` are the
  existing MacroEditor callbacks (popover kinds Image/Color) — dragging a box
  on the frame authors a Visual Wait exactly as today, just on a bigger frame.
- **Timeline:** full chrome (zoom, legend, lanes). `videoMs` follows the
  player's time; clicking seeks the player (same wiring as StudioEditor).
  Drag sets the shared segment range.
- **Copy fix:** `StudioTimeline` gains an optional prop (e.g.
  `rangeLabel: "loop" | "selection"`, default `"loop"`) controlling the hint
  ("drag to loop a range" → "drag to select a range") and the chip label
  ("⟳ loop a–b ✕" → "selection a–b ✕"). StudioEditor is untouched.

## Sidebar (AddNodePanel restructure)

Order and content:

1. **Recording** — shadcn Select at top, outside any section: the shared
   context everything below depends on. Selecting opens the dock; the
   "(no video)" filtering behavior is unchanged.
2. **Add Segment** — a range chip reflecting the dock selection
   ("0:02–0:04 · 3 events ✕", clears on ✕), Start/End as shadcn `Input`s
   (two-way sync with the drag, same rounding rules and validation as today),
   and the Add Segment button. When no recording: muted hint.
3. **Add Text Wait** — unchanged logic; `expect`/`timeout` become shadcn
   `Input`s.
4. **Add Visual Wait** — hint card only: "Drag a box on the video frame in
   the dock to add an image or color wait." No embedded player.

## State

`recordingId` and `rangeMs` lift from AddNodePanel into MacroEditor, passed
down to both the sidebar and the dock (plain props, no context — two
consumers). The numeric-buffer states (`startS`/`endS`) stay inside
AddNodePanel; the rounding invariant (summary count === built node's event
count) is preserved by keeping `handleLoopChange`'s Math.round at the point
where the dock's drag lands in shared state. Changing recording resets the
range (as today).

## Testing

- **AddNodePanel tests:** form logic (validation, rounding, node shapes,
  reset-on-clear) stays, driven through props instead of an embedded
  timeline; drag-interaction tests move to the dock test.
- **AuthoringDock tests (new):** timeline drag → `onRangeChange` with rounded
  ms; player stub's `onSaveTarget` → WaitFor node path; seek wiring.
- **MacroEditor tests:** dock appears when a recording is selected,
  absent otherwise.
- **StudioTimeline test:** label-prop rendering (loop vs selection copy).
- Resizable divider behavior is library-owned (`react-resizable-panels`) and
  not unit-tested.

## Out of Scope

- Persisting panel sizes across sessions.
- Compact variants of StudioPlayer/StudioTimeline.
- Any change to macro run/save flows, the canvas, or backend commands.
- Reworking Add Text Wait beyond input styling.
