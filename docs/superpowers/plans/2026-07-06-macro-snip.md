# Visual Segment Snipping (Sub-Project C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Snip a Segment node by dragging a range on a recording's event timeline (reusing `StudioTimeline`'s drag-select) instead of typing start/end seconds. Spec: `docs/superpowers/specs/2026-07-06-macro-snip-design.md`.

**Architecture:** Extract B's inline segment-building logic into pure shared builders (`macro-segment.ts`), then make `AddNodePanel`'s Add Segment form drive those builders from a `StudioTimeline` drag-selection synced with numeric inputs. No backend, no node-shape, no command changes — the produced Segment node is byte-identical to B's.

**Tech Stack:** React 19, `StudioTimeline` (existing), vitest+RTL.

## Global Constraints

- **No backend changes; produced Segment node byte-identical to B's** (`{ type:"Segment", events, speed:1, provenance:{recording_id,start_ms,end_ms} }`, x:40, y:40).
- **Reuse `StudioTimeline`** for range selection via its `onLoopChange`→`LoopRegion {a,b}` (video-relative ms). Its `startMs` prop IS the relative basis, so the `{a,b}` it emits are already in the rel-ms space the segment filter uses.
- **Basis is `recording.video.start_ms ?? recording.created_at`** — used identically as the `StudioTimeline` `startMs` prop AND the event-filter basis (keeps them aligned). `Math.round` all persisted ms.
- **Visual + numeric synced**, one source of truth `{ startMs, endMs }`.
- **No perception revival** (that's D); `PERCEPTION_STUDIO_UI` stays false.
- Existing `AddNodePanel`/`MacroEditor` tests stay green (text-wait path untouched; segment output node unchanged).
- Checks per task: `pnpm vitest run src`, `pnpm typecheck`, `pnpm lint:fix`.
- TS types: `Recording` (`.video?.{start_ms,duration_ms}`, `.events:InputEvent[]`, `.created_at`), `InputEvent` (`.timestamp`), `MacroNode`, `LoopRegion` (from StudioTimeline).

## File Structure
- `src/lib/macro-segment.ts` (NEW, +test) — `eventsInRange`, `segmentNodeFromRange`.
- `src/components/studio/macros/AddNodePanel.tsx` (MODIFY) — timeline range picker for Add Segment; call the shared builders.

---

### Task 1: Shared segment builders + refactor AddNodePanel to use them

**Files:** Create `src/lib/macro-segment.ts`, `src/lib/macro-segment.test.ts`; Modify `src/components/studio/macros/AddNodePanel.tsx`.

**Interfaces (Produces):**
- `export function eventsInRange(events: InputEvent[], basis: number, startMs: number, endMs: number): InputEvent[]` — keep events whose `e.timestamp - basis` is in `[startMs, endMs]` (inclusive both ends).
- `export function segmentBasis(recording: Recording): number` — `recording.video?.start_ms ?? recording.created_at`.
- `export function segmentNodeFromRange(recording: Recording, startMs: number, endMs: number): MacroNode` — rounds the ms, filters via `eventsInRange(recording.events, segmentBasis(recording), rStart, rEnd)`, returns `{ id: crypto.randomUUID(), kind: { type: "Segment", events: filtered, speed: 1, provenance: { recording_id: recording.id, start_ms: rStart, end_ms: rEnd } }, x: 40, y: 40 }`.

- [ ] **Step 1: Failing tests** (`macro-segment.test.ts`):

```ts
import { describe, expect, it } from "vitest";
import { eventsInRange, segmentBasis, segmentNodeFromRange } from "./macro-segment";
import type { InputEvent, Recording } from "@/types";

const ev = (t: number): InputEvent => ({ type: "MouseMove", x: 0, y: 0, timestamp: t } as InputEvent);
const rec = (over: Partial<Recording> = {}): Recording => ({
  id: "r1",
  name: "r",
  created_at: 1000,
  playback_speed: 1,
  events: [ev(1000), ev(2000), ev(3000), ev(4000), ev(5000)], // basis+0..+4000
  video: { path: "r1.mp4", start_ms: 1000, duration_ms: 5000, width: 100, height: 100, fps: 30, has_audio: false },
  ...over,
});

describe("macro-segment", () => {
  it("segmentBasis prefers video.start_ms, falls back to created_at", () => {
    expect(segmentBasis(rec())).toBe(1000);
    expect(segmentBasis(rec({ video: undefined }))).toBe(1000); // created_at
    expect(segmentBasis(rec({ created_at: 42, video: undefined }))).toBe(42);
  });

  it("eventsInRange filters inclusive against the basis", () => {
    const r = rec();
    const inRange = eventsInRange(r.events, 1000, 1000, 3000); // rel 1000..3000
    expect(inRange.map((e) => e.timestamp)).toEqual([2000, 3000, 4000]);
  });

  it("segmentNodeFromRange builds the exact node with rounded provenance", () => {
    const node = segmentNodeFromRange(rec(), 1000.4, 3000.6);
    expect(node.kind.type).toBe("Segment");
    if (node.kind.type !== "Segment") throw new Error();
    expect(node.kind.speed).toBe(1);
    expect(node.kind.provenance).toEqual({ recording_id: "r1", start_ms: 1000, end_ms: 3001 });
    expect(node.kind.events.map((e) => e.timestamp)).toEqual([2000, 3000, 4000]);
    expect(node.x).toBe(40);
    expect(node.y).toBe(40);
  });
});
```

- [ ] **Step 2:** `pnpm vitest run src/lib/macro-segment.test.ts` → FAIL.
- [ ] **Step 3: Implement** `macro-segment.ts` per the interfaces. Then refactor `AddNodePanel.handleAddSegment` to call `segmentNodeFromRange(selected, start*1000, end*1000)` (the panel's start/end are in seconds → ×1000; the builder rounds). Remove the now-duplicated inline filter/provenance code from `AddNodePanel`. This is behavior-preserving — the existing `AddNodePanel` segment tests MUST stay green (they assert the same node shape).
- [ ] **Step 4:** `pnpm vitest run src && pnpm typecheck && pnpm lint:fix` → PASS (existing AddNodePanel tests green).
- [ ] **Step 5: Commit** `git add src/lib/macro-segment.ts src/lib/macro-segment.test.ts src/components/studio/macros/AddNodePanel.tsx && git commit -m "feat(macros): shared segment builders reused by the add panel"`

---

### Task 2: Timeline-backed range picker in Add Segment

**Files:** Modify `src/components/studio/macros/AddNodePanel.tsx` (+ its test).

**Interfaces:** No new exports. The Add Segment sub-form, when a recording is selected, renders a `StudioTimeline` and drives one `{ startMs, endMs }` state from its drag-selection AND the numeric inputs.

Wiring:
- State: `const [rangeMs, setRangeMs] = useState<{ start: number; end: number } | null>(null)`. Numeric second inputs derive from it (`start/1000`, `end/1000`) and editing them updates it (`×1000`, rounded, clamped `[0, duration_ms]`, `end>start`).
- Render `StudioTimeline` with: `events={selected.events}`, `startMs={segmentBasis(selected)}`, `durationMs={selected.video.duration_ms}`, `videoMs={0}`, `onSeekSeconds={() => {}}`, `loop={rangeMs ? { a: rangeMs.start, b: rangeMs.end } : null}`, `onLoopChange={(lr) => setRangeMs(lr ? { start: lr.a, end: lr.b } : null)}`. (StudioTimeline's `LoopRegion {a,b}` is video-relative ms = the same rel space `segmentNodeFromRange` filters in, because `startMs`=basis.)
- Live summary: `${eventsInRange(selected.events, segmentBasis(selected), rangeMs.start, rangeMs.end).length} events · ${((rangeMs.end - rangeMs.start)/1000).toFixed(1)}s` (or "Drag on the timeline to select a range" when `rangeMs` is null).
- Add disabled unless `rangeMs && rangeMs.end > rangeMs.start`. On Add: `onAdd(segmentNodeFromRange(selected, rangeMs.start, rangeMs.end))`.

- [ ] **Step 1: Failing test** (extend `AddNodePanel.test.tsx`; reuse StudioTimeline's `getBoundingClientRect` + pointer-capture stubs — copy the `beforeEach` from `StudioTimeline.test.tsx`):

```tsx
it("drags a range on the timeline and adds a segment with those events", () => {
  const onAdd = vi.fn();
  const rec = /* a Recording whose 5 events span basis+0..+4000, video duration 5000ms, start_ms=basis */;
  const { container } = render(<AddNodePanel recordings={[rec]} onAdd={onAdd} />);
  // select the recording, then drag the timeline track from 40% to 80% (→ rel ~2000..4000ms over a 5000ms/100px mock)
  // fire pointerDown/Move/Up on the .tl-track; assert the summary shows the in-range count,
  // then click Add and assert onAdd's node.kind.events are exactly the in-range events + provenance ms.
});

it("disables Add until a range is selected", () => { /* no drag → Add disabled; after drag → enabled */ });
```

(Author full bodies from these specs, mirroring StudioTimeline.test.tsx's drag mechanics and the mocked 100px/rect math so the 40%→80% drag maps to a known rel-ms range.)

- [ ] **Step 2:** `pnpm vitest run src/components/studio/macros/AddNodePanel.test.tsx` → FAIL.
- [ ] **Step 3: Implement** the timeline range picker per the wiring above. Keep the numeric inputs (synced) for precision. Add Text Wait unchanged.
- [ ] **Step 4:** `pnpm vitest run src && pnpm typecheck && pnpm lint:fix` → PASS (all prior macro/studio tests green).
- [ ] **Step 5: Manual smoke (controller/user):** `pnpm tauri dev` → Studio → Macro editor → create a macro → Add Segment: pick a recording, drag a range on the timeline, confirm the "N events" summary matches, Add it, and verify the segment node on the canvas replays those events on Run.
- [ ] **Step 6: Commit** `git commit -am "feat(macros): drag-to-snip segment range on the timeline"`

---

## Spec-coverage checklist (self-review)
- Shared builders (eventsInRange/segmentBasis/segmentNodeFromRange) + AddNodePanel refactor → Task 1. Timeline drag range picker + synced numeric + summary + node build → Task 2.
- Type consistency: segment node shape identical to B's; basis identical to B's; `LoopRegion {a,b}` rel-ms == `segmentNodeFromRange` filter space (both keyed off basis).
- Deferred (absent): template/color wait region-select authoring (D), branching, run history.
