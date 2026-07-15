# In/Out Clipping — Mark a Segment While Watching

**Context:** Segment authoring today happens on the dock timeline (drag to
select) or via the sidebar's Start/End numeric inputs. Neither feels like
clipping video: you cannot mark the moment you are watching. This adds
video-editor In/Out marking to the AuthoringDock so the whole flow —
find the moment, mark it, add the node — happens at the player without
touching the sidebar.

**Prior art in-repo:** the dock (AuthoringDock) already owns the playhead
(`videoS`, via StudioPlayer `onTimeUpdate`), the shared range
(`range`/`onRangeChange`, video-relative whole ms), loop preview
(`loopRegion`), and the portaled transport bar (`controlsHost` div in the
timeline column).

---

## Global Constraints

- **StudioPlayer, StudioTimeline, AddNodePanel, and the backend are
  untouched.** All changes live in AuthoringDock and MacroEditor.
- Marks write the **existing shared range** — every downstream behavior
  (loop preview, timeline highlight, sidebar chip/inputs sync, rounding
  invariant) is inherited, not reimplemented.
- Timeline drag-select and sidebar numeric entry keep working as
  alternative ways to set the same range.

## Interaction

While the dock is mounted (a recording with video is selected):

| Input | Effect |
|---|---|
| `I` key or `⌈ In` button | Mark In at the playhead |
| `O` key or `⌋ Out` button | Mark Out at the playhead |
| `Enter` | Add the segment (when a valid range exists) |
| `Escape` | Clear the range |

**Mark semantics** (playhead `p` = `Math.round(videoS * 1000)`, duration
`d` = `video.duration_ms`):

- **In:** `onRangeChange({ a: p, b: range && range.b > p ? range.b : d })`
  — keeps the existing Out if it is still after `p`, else extends to the
  end of the video. A lone In therefore means "from here to the end".
- **Out:** `onRangeChange({ a: range && range.a < p ? range.a : 0, b: p })`
  — keeps the existing In if still before `p`, else starts at 0. A lone
  Out means "start to here".
- Marks always produce a complete `{a, b}` with `b > a` in whole ms; there
  is no half-marked state. Re-pressing I or O re-marks. Edge case: In at
  the exact end of the video (`p == d`) or Out at 0 would produce `b == a`
  — the handler no-ops in that case rather than emitting an invalid range.

**Keyboard scope:** a `window` keydown listener registered while
AuthoringDock is mounted (cleaned up on unmount). Events are ignored when
`event.target` is an `<input>`, `<textarea>`, `<select>`, or
`contentEditable` element, and when any modifier (meta/ctrl/alt) is held —
so typing in the sidebar forms or using app shortcuts never marks. `Enter`
and `Escape` are only claimed (preventDefault) when they act — Enter with
no valid range and Escape with no range fall through untouched.

## Dock UI

A new row in the dock's timeline column, directly below the portaled
transport bar (`.adock-controls`) and above the timeline:

- `⌈ In` and `⌋ Out` buttons, always visible while the dock is open,
  styled like the existing dock/timeline chrome; tooltips name the I/O
  shortcut keys.
- When a range exists: the same chip the sidebar shows —
  `0:05–0:09 · 12 events ✕` — plus an `+ Add Segment` button. The chip's
  ✕ clears the range (`onRangeChange(null)`); Add fires `onAddSegment`.
- The event count reuses `eventsInRange(recording.events,
  segmentBasis(recording), range.a, range.b)` — identical inputs to the
  sidebar's chip and to `segmentNodeFromRange`, so counts always agree.

## Component Changes

**AuthoringDock** (all UI + key handling):
- New prop: `onAddSegment: () => void`.
- Renders the In/Out buttons, chip, and Add button; owns the keydown
  listener; computes marks from `videoS` + `recording.video.duration_ms`.

**MacroEditor** (one callback):
- `handleAddSegmentFromDock`: guards on `authoringRecording` +
  `authoringRange` with `b > a`, then
  `handleAddNode(segmentNodeFromRange(authoringRecording, range.a, range.b))`
  — the exact same node the sidebar path builds.
- Passes it as `onAddSegment` to AuthoringDock.

## Testing

**AuthoringDock tests** (extend existing file; StudioPlayer stays stubbed,
StudioTimeline real):
- In with no range → `{a: p, b: duration_ms}`; Out with no range →
  `{a: 0, b: p}`.
- In before an existing Out keeps the Out; In after the existing Out
  extends to duration. Out mirror cases.
- In at `p == duration_ms` no-ops (no `onRangeChange` call).
- Keydown on a focused `<input>` does not mark; `cmd+i` does not mark.
- Enter with a valid range calls `onAddSegment`; Enter without one does
  not. Escape with a range clears it.
- Chip renders the event count for a given recording + range; ✕ clears.

**MacroEditor test:** dock stub gains an "add segment" trigger →
`onAddSegment` produces a canvas node whose Segment event count matches
the range (same pattern as the existing dock-range test).

## Out of Scope

- Filmstrip/thumbnail UI, trim handles on the scrub bar.
- Persisting marks separately from the range (marks ARE the range).
- Changing the sidebar forms.
- J/K/L shuttle keys or other editor keyboard conventions.
