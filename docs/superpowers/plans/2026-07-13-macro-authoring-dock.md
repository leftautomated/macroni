# Macro Authoring Dock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the macro editor's cramped sidebar-embedded timeline/player with a Blender/Figma-style tiled workspace: a resizable sidebar of forms, and a full-width resizable bottom dock hosting the real StudioPlayer + StudioTimeline for segment and visual-wait authoring.

**Architecture:** `MacroEditor` owns the shared authoring state (`recordingId`, `range`) and lays out sidebar/canvas/dock with shadcn `Resizable` (react-resizable-panels). A new `AuthoringDock` pairs `StudioPlayer` (left) and `StudioTimeline` (right); dragging on the timeline sets the shared range (which also loops playback via `loopRegion`), and dragging a box on the frame authors a visual wait via the existing popover flow. `AddNodePanel` becomes a controlled forms column.

**Tech Stack:** React 18 + TypeScript, Tauri 2, shadcn/ui (radix base), Tailwind v4, vitest + @testing-library/react (jsdom), biome, pnpm.

**Spec:** `docs/superpowers/specs/2026-07-13-macro-authoring-dock-design.md`

## Global Constraints

- **No backend changes.** Node-building stays in `src/lib/macro-segment.ts` / `src/lib/macro-wait.ts`; Tauri commands `save_target` / `extract_region` are reused unchanged.
- **Reuse `StudioPlayer`/`StudioTimeline` as-is** apart from one new optional prop on the timeline (`rangeWord`).
- shadcn components are installed via `pnpm dlx shadcn@latest add <name>`, never copy-pasted. `src/components/ui/` is excluded from biome.
- Biome style: single quotes are NOT used here — this repo's biome config emits double quotes and semicolons (see any `src/**` file); type-only imports need the `type` keyword; imports auto-sorted.
- Single-file test runs: `pnpm vitest run <file>`.
- Every commit message ends with:
  `Claude-Session: https://claude.ai/code/session_017i9yz2dmA4pvXWkwbV577L`

## File Structure

| File | Responsibility |
|---|---|
| `src/components/studio/StudioTimeline.tsx` (modify) | + `rangeWord?: "loop" \| "selection"` copy prop |
| `src/components/studio/StudioTimeline.test.tsx` (modify) | + wording test |
| `src/components/studio/macros/AuthoringDock.tsx` (create) | Dock: player + timeline, range rounding, loop preview |
| `src/components/studio/macros/AuthoringDock.test.tsx` (create) | Dock unit tests |
| `src/components/studio/macros/AddNodePanel.tsx` (modify) | Controlled forms column: recording select, chip, shadcn Inputs, hint cards |
| `src/components/studio/macros/AddNodePanel.test.tsx` (modify) | Harness-driven form tests |
| `src/components/studio/macros/MacroEditor.tsx` (modify) | State lift, resizable layout, dock wiring, visual-wait node building |
| `src/components/studio/macros/MacroEditor.test.tsx` (modify) | Dock visibility + shared-state integration tests |
| `src/components/studio/macros/macro-editor.css` (modify) | Panel/dock/chip styles; drop grid columns |
| `src/components/ui/resizable.tsx`, `src/components/ui/input.tsx` (create via CLI) | shadcn primitives |

---

### Task 1: StudioTimeline `rangeWord` prop

**Files:**
- Modify: `src/components/studio/StudioTimeline.tsx`
- Test: `src/components/studio/StudioTimeline.test.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces: `StudioTimelineProps.rangeWord?: "loop" | "selection"` (default `"loop"`). With `"selection"`: empty-state hint reads `drag to select a range`; the active-range chip reads `selection <a>–<b> ✕` instead of `⟳ loop <a>–<b> ✕`. Behavior (drag, clear, callbacks) is identical.

- [ ] **Step 1: Write the failing test**

Append to the `describe` block in `src/components/studio/StudioTimeline.test.tsx` (it already has a `base` props fixture and `noop`; reuse them — check the top of the file for the exact fixture name and required props):

```tsx
it("swaps loop wording for selection wording when rangeWord='selection'", () => {
  const { rerender } = render(
    <StudioTimeline
      {...base}
      rangeWord="selection"
      loop={null}
      onSeekSeconds={noop}
      onLoopChange={noop}
    />,
  );
  expect(screen.getByText("drag to select a range")).toBeInTheDocument();

  // base's durationMs is 2000 — keep the loop inside the track.
  rerender(
    <StudioTimeline
      {...base}
      rangeWord="selection"
      loop={{ a: 500, b: 1500 }}
      onSeekSeconds={noop}
      onLoopChange={noop}
    />,
  );
  expect(screen.getByRole("button", { name: /selection 0:00–0:01/ })).toBeInTheDocument();
  expect(screen.queryByText(/⟳ loop/)).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/components/studio/StudioTimeline.test.tsx`
Expected: FAIL — TypeScript/react unknown prop is silently ignored, so the failure is `getByText("drag to select a range")` finding nothing (actual text: "drag to loop a range").

- [ ] **Step 3: Implement the prop**

In `src/components/studio/StudioTimeline.tsx`, add to `StudioTimelineProps`:

```tsx
  /** Word used for the dragged range: the player context loops playback
   * ("loop"), the macro authoring dock selects a segment ("selection"). */
  rangeWord?: "loop" | "selection";
```

Destructure it in the component signature with default: `rangeWord = "loop",`.

Replace the control-row hint/chip block (currently around lines 378–384):

```tsx
        {loop ? (
          <button type="button" className="tl-clear" onClick={() => onLoopChange(null)}>
            {rangeWord === "selection" ? "selection" : "⟳ loop"} {fmt(loop.a)}–{fmt(loop.b)} ✕
          </button>
        ) : (
          <span style={{ color: "rgba(255,255,255,0.3)" }}>
            drag to {rangeWord === "selection" ? "select" : "loop"} a range
          </span>
        )}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/components/studio/StudioTimeline.test.tsx`
Expected: PASS (all tests — the default-wording tests must still pass untouched).

- [ ] **Step 5: Lint and commit**

```bash
pnpm biome check --write src/components/studio/StudioTimeline.tsx src/components/studio/StudioTimeline.test.tsx
git add src/components/studio/StudioTimeline.tsx src/components/studio/StudioTimeline.test.tsx
git commit -m "Add rangeWord prop to StudioTimeline for selection contexts

Claude-Session: https://claude.ai/code/session_017i9yz2dmA4pvXWkwbV577L"
```

---

### Task 2: AuthoringDock component

**Files:**
- Create: `src/components/studio/macros/AuthoringDock.tsx`
- Test: `src/components/studio/macros/AuthoringDock.test.tsx`
- Modify: `src/components/studio/macros/macro-editor.css` (dock styles)

**Interfaces:**
- Consumes: `StudioPlayer` (`ref: StudioPlayerHandle`, `src`, `fps`, `onTimeUpdate`, `onReplay`, `loopRegion` seconds, `onSaveTarget`, `onSampleColor`, `popoverKinds`), `StudioTimeline` (+ Task 1's `rangeWord`), `useVideoAssetUrl(video)` → `{ url }`, `segmentBasis(recording)`.
- Produces:

```tsx
export interface AuthoringDockProps {
  /** Selected recording; callers only render the dock when `video` is set. */
  recording: Recording;
  /** Shared segment range, video-relative ms (integers). */
  range: LoopRegion | null;
  /** Fires with whole-ms values (rounded here) or null on clear. */
  onRangeChange: (range: LoopRegion | null) => void;
  onSaveTarget: (target: PerceptionTarget, timestampMs: number) => Promise<void>;
  onSampleColor: (region: Region, timestampMs: number) => Promise<[number, number, number]>;
}
export function AuthoringDock(props: AuthoringDockProps): JSX.Element;
```

- [ ] **Step 1: Write the failing tests**

Create `src/components/studio/macros/AuthoringDock.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { InputEventType, type InputEvent, type PerceptionTarget, type Recording } from "@/types";

// The dock's unit under test is its wiring: range→loopRegion conversion,
// drag→rounded onRangeChange, and passthrough of the target-authoring hooks.
// StudioPlayer itself (video element, popover) is stubbed to expose those
// props; StudioTimeline renders for real so the drag math is exercised.
const fixtures = vi.hoisted(() => ({
  target: {
    id: "t1",
    name: "Target",
    modality: "visual",
    region: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
    kind: { type: "TemplateMatch", image: "", threshold: 0.8, source_px: [0, 0] },
    created_at: 1,
  },
}));

vi.mock("@/components/studio/StudioPlayer", () => ({
  StudioPlayer: ({
    loopRegion,
    onSaveTarget,
  }: {
    loopRegion?: { a: number; b: number } | null;
    onSaveTarget?: (target: PerceptionTarget, timestampMs: number) => Promise<void>;
  }) => (
    <div data-testid="player-stub">
      <div>loop: {loopRegion ? `${loopRegion.a}-${loopRegion.b}` : "none"}</div>
      <button
        type="button"
        onClick={() => onSaveTarget?.(fixtures.target as PerceptionTarget, 4200)}
      >
        Simulate save
      </button>
    </div>
  ),
}));

vi.mock("@/hooks/useVideoAssetUrl", () => ({
  useVideoAssetUrl: () => ({ url: "asset://video.mp4", error: null }),
}));

import { AuthoringDock } from "./AuthoringDock";

beforeEach(() => {
  Element.prototype.getBoundingClientRect = vi.fn(
    () =>
      ({
        left: 0,
        top: 0,
        right: 137,
        bottom: 50,
        width: 137,
        height: 50,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect,
  );
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});

function mkEvent(key: string, timestamp: number): InputEvent {
  return { type: InputEventType.KeyPress, key, timestamp };
}

const recording: Recording = {
  id: "rec-1",
  name: "Recording One",
  events: [mkEvent("a", 100), mkEvent("b", 292)],
  created_at: 500,
  playback_speed: 1,
  video: {
    path: "/tmp/rec-1.mp4",
    start_ms: 0,
    duration_ms: 5000,
    width: 1920,
    height: 1080,
    fps: 30,
    has_audio: false,
  },
};

const baseProps = {
  recording,
  range: null,
  onRangeChange: () => {},
  onSaveTarget: async () => {},
  onSampleColor: async (): Promise<[number, number, number]> => [0, 0, 0],
};

describe("AuthoringDock", () => {
  it("rounds a timeline drag to whole ms before emitting onRangeChange", () => {
    const onRangeChange = vi.fn();
    const { container } = render(<AuthoringDock {...baseProps} onRangeChange={onRangeChange} />);

    // 137px track / 5000ms: msAt(8) = 8/137×5000 = 291.9708… → must emit 292.
    const track = container.querySelector(".tl-track") as HTMLElement;
    fireEvent.pointerDown(track, { clientX: 0, pointerId: 1 });
    fireEvent.pointerMove(track, { clientX: 8, pointerId: 1 });
    fireEvent.pointerUp(track, { clientX: 8, pointerId: 1 });

    expect(onRangeChange).toHaveBeenCalledWith({ a: 0, b: 292 });
  });

  it("feeds the shared range to the player's loopRegion in seconds", () => {
    render(<AuthoringDock {...baseProps} range={{ a: 2000, b: 4000 }} />);
    expect(screen.getByText("loop: 2-4")).toBeInTheDocument();
  });

  it("shows the selection wording, not loop wording, on its timeline", () => {
    render(<AuthoringDock {...baseProps} />);
    expect(screen.getByText("drag to select a range")).toBeInTheDocument();
  });

  it("passes onSaveTarget through to the player", async () => {
    const onSaveTarget = vi.fn().mockResolvedValue(undefined);
    render(<AuthoringDock {...baseProps} onSaveTarget={onSaveTarget} />);
    await userEvent.click(screen.getByRole("button", { name: /simulate save/i }));
    expect(onSaveTarget).toHaveBeenCalledWith(fixtures.target, 4200);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/components/studio/macros/AuthoringDock.test.tsx`
Expected: FAIL — `Cannot find module './AuthoringDock'`.

- [ ] **Step 3: Implement AuthoringDock**

Create `src/components/studio/macros/AuthoringDock.tsx`:

```tsx
import { useRef, useState } from "react";
import type { KindOption } from "@/components/studio/CreateTargetPopover";
import { StudioPlayer, type StudioPlayerHandle } from "@/components/studio/StudioPlayer";
import { type LoopRegion, StudioTimeline } from "@/components/studio/StudioTimeline";
import { useVideoAssetUrl } from "@/hooks/useVideoAssetUrl";
import { segmentBasis } from "@/lib/macro-segment";
import type { PerceptionTarget, Recording, Region } from "@/types";

// Visual Wait authoring in the dock is Image/Color only — Text waits have
// their own dedicated sidebar form (mirrors the old embedded-player scoping).
const DOCK_POPOVER_KINDS: KindOption[] = ["Image", "Color"];

const noop = () => {};

export interface AuthoringDockProps {
  /** Selected recording; callers only render the dock when `video` is set. */
  recording: Recording;
  /** Shared segment range, video-relative ms (integers). */
  range: LoopRegion | null;
  /** Fires with whole-ms values (rounded here) or null on clear. */
  onRangeChange: (range: LoopRegion | null) => void;
  onSaveTarget: (target: PerceptionTarget, timestampMs: number) => Promise<void>;
  onSampleColor: (region: Region, timestampMs: number) => Promise<[number, number, number]>;
}

/**
 * Bottom authoring dock for the macro editor: the real StudioPlayer and
 * StudioTimeline at full width, exactly as the main studio pairs them.
 * Dragging on the timeline selects the shared segment range (which the
 * player then loops, previewing the segment); dragging a box on the frame
 * authors an Image/Color wait through the player's existing popover flow.
 */
export function AuthoringDock({
  recording,
  range,
  onRangeChange,
  onSaveTarget,
  onSampleColor,
}: AuthoringDockProps) {
  const playerRef = useRef<StudioPlayerHandle>(null);
  const [videoS, setVideoS] = useState(0);
  const { url } = useVideoAssetUrl(recording.video);

  return (
    <div className="adock-root">
      <div className="adock-player">
        <StudioPlayer
          key={recording.id}
          ref={playerRef}
          src={url ?? ""}
          fps={recording.video?.fps ?? 30}
          onTimeUpdate={setVideoS}
          onReplay={noop}
          loopRegion={range ? { a: range.a / 1000, b: range.b / 1000 } : null}
          onSaveTarget={onSaveTarget}
          onSampleColor={onSampleColor}
          popoverKinds={DOCK_POPOVER_KINDS}
        />
      </div>
      <div className="adock-timeline">
        <StudioTimeline
          events={recording.events}
          startMs={segmentBasis(recording)}
          durationMs={recording.video?.duration_ms ?? 0}
          videoMs={videoS * 1000}
          onSeekSeconds={(s) => playerRef.current?.seek(s)}
          loop={range}
          onLoopChange={(l) =>
            // Round where the drag lands in shared state, so the sidebar's
            // event summary and segmentNodeFromRange (which rounds
            // internally) always filter on identical bounds.
            onRangeChange(l ? { a: Math.round(l.a), b: Math.round(l.b) } : null)
          }
          rangeWord="selection"
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Add dock styles**

Append to `src/components/studio/macros/macro-editor.css`:

```css
.adock-root {
  display: flex;
  gap: 16px;
  height: 100%;
  min-height: 0;
  box-sizing: border-box;
  padding: 12px 16px;
  border-top: 1px solid var(--macro-line);
  background: rgb(10 10 10 / 82%);
}

.adock-player {
  flex: 0 0 52%;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.adock-timeline {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run src/components/studio/macros/AuthoringDock.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 6: Lint and commit**

```bash
pnpm biome check --write src/components/studio/macros/AuthoringDock.tsx src/components/studio/macros/AuthoringDock.test.tsx
git add src/components/studio/macros/AuthoringDock.tsx src/components/studio/macros/AuthoringDock.test.tsx src/components/studio/macros/macro-editor.css
git commit -m "Add AuthoringDock: full-width player + timeline for macro authoring

Claude-Session: https://claude.ai/code/session_017i9yz2dmA4pvXWkwbV577L"
```

---

### Task 3: AddNodePanel becomes a controlled forms column

**Files:**
- Create (CLI): `src/components/ui/input.tsx`
- Modify: `src/components/studio/macros/AddNodePanel.tsx`
- Modify: `src/components/studio/macros/macro-editor.css` (chip styles)
- Test: `src/components/studio/macros/AddNodePanel.test.tsx`

**Interfaces:**
- Consumes: `LoopRegion` from `@/components/studio/StudioTimeline`; shadcn `Input`, existing `Select`.
- Produces (MacroEditor will render this in Task 4):

```tsx
export interface AddNodePanelProps {
  recordings: Recording[];
  /** Shared authoring context, owned by MacroEditor. */
  selectedRecordingId: string;
  onSelectRecording: (id: string) => void;
  /** Segment range from the dock timeline, video-relative ms, or null. */
  range: LoopRegion | null;
  onRangeChange: (range: LoopRegion | null) => void;
  onAdd: (node: MacroNode) => void;
}
```

Dropped props: `captureImageWait`, `sampleColor` (move to MacroEditor→dock in Task 4). The StudioPlayer/StudioTimeline embeds, `useVideoAssetUrl`, and `waitNodeFromTarget`-for-visual-targets all leave this file; `waitNodeFromTarget` stays only for the Text Wait form.

- [ ] **Step 1: Install the shadcn Input**

```bash
pnpm dlx shadcn@latest add input
```

Expected: `Created 1 file: src/components/ui/input.tsx`.

- [ ] **Step 2: Rewrite the test file**

Replace `src/components/studio/macros/AddNodePanel.test.tsx` entirely with:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import type { LoopRegion } from "@/components/studio/StudioTimeline";
import { InputEventType, type InputEvent, type MacroNode, type Recording } from "@/types";
import { AddNodePanel } from "./AddNodePanel";

function mkEvent(key: string, timestamp: number): InputEvent {
  return { type: InputEventType.KeyPress, key, timestamp };
}

const recordingWithVideo: Recording = {
  id: "rec-1",
  name: "Recording One",
  events: [
    mkEvent("e0", 1000),
    mkEvent("e1", 2000),
    mkEvent("e2", 3000),
    mkEvent("e3", 4000),
    mkEvent("e4", 5000),
  ],
  created_at: 500,
  playback_speed: 1,
  video: {
    path: "/tmp/rec-1.mp4",
    start_ms: 1000,
    duration_ms: 5000,
    width: 1920,
    height: 1080,
    fps: 30,
    has_audio: false,
  },
};

const recordingWithoutVideo: Recording = {
  id: "rec-2",
  name: "No Video Recording",
  events: [],
  created_at: 0,
  playback_speed: 1,
};

const recordings: Recording[] = [recordingWithVideo, recordingWithoutVideo];

// AddNodePanel is controlled: MacroEditor owns recordingId + range. This
// harness reproduces that ownership (including range-reset-on-switch) and
// exposes a button standing in for a dock drag.
function Harness({
  recordings: recs,
  onAdd = () => {},
  dockRange = { a: 2000, b: 4000 },
}: {
  recordings: Recording[];
  onAdd?: (node: MacroNode) => void;
  dockRange?: LoopRegion;
}) {
  const [recordingId, setRecordingId] = useState("");
  const [range, setRange] = useState<LoopRegion | null>(null);
  return (
    <>
      <AddNodePanel
        recordings={recs}
        selectedRecordingId={recordingId}
        onSelectRecording={(id) => {
          setRecordingId(id);
          setRange(null);
        }}
        range={range}
        onRangeChange={setRange}
        onAdd={onAdd}
      />
      <button type="button" onClick={() => setRange(dockRange)}>
        Simulate dock drag
      </button>
    </>
  );
}

async function selectRecording(name: string | RegExp) {
  await userEvent.click(screen.getByRole("combobox", { name: /recording/i }));
  await userEvent.click(await screen.findByRole("option", { name }));
}

async function setStartEnd(start: string, end: string) {
  const startInput = screen.getByRole("spinbutton", { name: /start/i });
  const endInput = screen.getByRole("spinbutton", { name: /end/i });
  await userEvent.clear(startInput);
  if (start) await userEvent.type(startInput, start);
  await userEvent.clear(endInput);
  if (end) await userEvent.type(endInput, end);
}

describe("AddNodePanel", () => {
  it("only lists recordings that have video", async () => {
    render(<Harness recordings={recordings} />);
    await userEvent.click(screen.getByRole("combobox", { name: /recording/i }));
    expect(await screen.findByRole("option", { name: /recording one/i })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /no video recording/i })).not.toBeInTheDocument();
  });

  it("adds a Segment node from typed start/end with filtered events and provenance", async () => {
    const onAdd = vi.fn();
    render(<Harness recordings={recordings} onAdd={onAdd} />);

    await selectRecording("Recording One");
    await setStartEnd("1", "3");
    await userEvent.click(screen.getByRole("button", { name: /add segment/i }));

    expect(onAdd).toHaveBeenCalledTimes(1);
    const node = onAdd.mock.calls[0][0];
    expect(node.kind.type).toBe("Segment");
    expect(node.kind.events).toEqual([
      mkEvent("e1", 2000),
      mkEvent("e2", 3000),
      mkEvent("e3", 4000),
    ]);
    expect(node.kind.provenance).toEqual({
      recording_id: "rec-1",
      start_ms: 1000,
      end_ms: 3000,
    });
  });

  it("rounds fractional-second typed values to integer ms", async () => {
    const onAdd = vi.fn();
    render(<Harness recordings={recordings} onAdd={onAdd} />);

    await selectRecording("Recording One");
    await setStartEnd("1.001", "3.0004");
    await userEvent.click(screen.getByRole("button", { name: /add segment/i }));

    const node = onAdd.mock.calls[0][0];
    expect(node.kind.provenance.start_ms).toBe(1001);
    expect(Number.isInteger(node.kind.provenance.end_ms)).toBe(true);
  });

  it("reflects an external (dock) range in the chip, summary count, and inputs", async () => {
    render(<Harness recordings={recordings} />);
    await selectRecording("Recording One");
    await userEvent.click(screen.getByRole("button", { name: /simulate dock drag/i }));

    // rel range [2000,4000] over basis 1000 → events e2,e3,e4.
    expect(screen.getByText(/0:02–0:04 · 3 events/)).toBeInTheDocument();
    expect(screen.getByRole("spinbutton", { name: /start/i })).toHaveValue(2);
    expect(screen.getByRole("spinbutton", { name: /end/i })).toHaveValue(4);
    expect(screen.getByRole("button", { name: /add segment/i })).toBeEnabled();
  });

  it("clears the range, inputs, and chip via the chip's clear button", async () => {
    render(<Harness recordings={recordings} />);
    await selectRecording("Recording One");
    await userEvent.click(screen.getByRole("button", { name: /simulate dock drag/i }));

    await userEvent.click(screen.getByRole("button", { name: /clear range/i }));

    expect(screen.queryByText(/3 events/)).not.toBeInTheDocument();
    expect(screen.getByRole("spinbutton", { name: /start/i })).toHaveValue(0);
    expect(screen.getByRole("spinbutton", { name: /end/i })).toHaveValue(null);
    expect(screen.getByRole("button", { name: /add segment/i })).toBeDisabled();
  });

  it("does not clobber a partially-typed buffer with the range echo", async () => {
    render(<Harness recordings={recordings} />);
    await selectRecording("Recording One");

    // End empty → every keystroke emits onRangeChange(null); the Start buffer
    // must keep the user's text rather than resetting to "0".
    const startInput = screen.getByRole("spinbutton", { name: /start/i });
    await userEvent.clear(startInput);
    await userEvent.type(startInput, "2");
    expect(startInput).toHaveValue(2);
  });

  it("disables Add Segment when end <= start, out of bounds, or nothing selected", async () => {
    render(<Harness recordings={recordings} />);
    expect(screen.getByRole("button", { name: /add segment/i })).toBeDisabled();

    await selectRecording("Recording One");
    await setStartEnd("3", "3");
    expect(screen.getByRole("button", { name: /add segment/i })).toBeDisabled();

    await setStartEnd("1", "10");
    expect(screen.getByRole("button", { name: /add segment/i })).toBeDisabled();
  });

  it("adds a WaitFor text node with the exact TextOcr target shape", async () => {
    const onAdd = vi.fn();
    render(<Harness recordings={recordings} onAdd={onAdd} />);

    await userEvent.type(screen.getByLabelText(/expect/i), "Submit");
    const timeoutInput = screen.getByRole("spinbutton", { name: /timeout/i });
    await userEvent.clear(timeoutInput);
    await userEvent.type(timeoutInput, "8");
    await userEvent.click(screen.getByRole("button", { name: /add text wait/i }));

    expect(onAdd).toHaveBeenCalledTimes(1);
    const node = onAdd.mock.calls[0][0];
    expect(node.kind.type).toBe("WaitFor");
    expect(node.kind.target.kind).toEqual({ type: "TextOcr", expect: "Submit" });
    expect(node.kind.timeout_ms).toBe(8000);
  });

  it("defaults the Wait timeout to 10s and disables on empty expect", async () => {
    const onAdd = vi.fn();
    render(<Harness recordings={recordings} onAdd={onAdd} />);
    expect(screen.getByRole("button", { name: /add text wait/i })).toBeDisabled();

    await userEvent.type(screen.getByLabelText(/expect/i), "Loaded");
    await userEvent.click(screen.getByRole("button", { name: /add text wait/i }));
    expect(onAdd.mock.calls[0][0].kind.timeout_ms).toBe(10000);
  });

  it("shows the visual-wait hint card pointing at the dock", async () => {
    render(<Harness recordings={recordings} />);
    expect(screen.getByText(/select a recording/i)).toBeInTheDocument();

    await selectRecording("Recording One");
    expect(screen.getByText(/drag a box on the video frame/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm vitest run src/components/studio/macros/AddNodePanel.test.tsx`
Expected: FAIL — the component still has its old props (`recordings`/`onAdd` only), so TypeScript errors and/or missing chip/hint queries.

- [ ] **Step 4: Rewrite AddNodePanel**

Replace `src/components/studio/macros/AddNodePanel.tsx` entirely with:

```tsx
import { useEffect, useMemo, useRef, useState } from "react";
import { Film, ImagePlus, Plus, ScanText } from "lucide-react";
import type { LoopRegion } from "@/components/studio/StudioTimeline";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { eventsInRange, segmentBasis, segmentNodeFromRange } from "@/lib/macro-segment";
import { waitNodeFromTarget } from "@/lib/macro-wait";
import type { MacroNode, PerceptionTarget, Recording } from "@/types";

const DEFAULT_TIMEOUT_S = 10;
const MIN_TIMEOUT_S = 1;

export interface AddNodePanelProps {
  recordings: Recording[];
  /** Shared authoring context, owned by MacroEditor. */
  selectedRecordingId: string;
  onSelectRecording: (id: string) => void;
  /** Segment range from the dock timeline, video-relative ms, or null. */
  range: LoopRegion | null;
  onRangeChange: (range: LoopRegion | null) => void;
  onAdd: (node: MacroNode) => void;
}

function fmtS(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function sameRange(x: LoopRegion | null, y: LoopRegion | null): boolean {
  return x === y || (!!x && !!y && x.a === y.a && x.b === y.b);
}

/**
 * Sidebar forms for building macro nodes. Fully controlled: the recording
 * selection and segment range live in MacroEditor (shared with the
 * AuthoringDock, where the actual timeline/frame dragging happens); this
 * component only collects form input and hands fully-formed MacroNodes to
 * `onAdd`.
 */
export function AddNodePanel({
  recordings,
  selectedRecordingId,
  onSelectRecording,
  range,
  onRangeChange,
  onAdd,
}: AddNodePanelProps) {
  const recordingsWithVideo = useMemo(() => recordings.filter((r) => r.video), [recordings]);
  const selected = recordingsWithVideo.find((r) => r.id === selectedRecordingId) ?? null;

  // Numeric-second text inputs are a separate, freely-editable buffer so the
  // user can type partial values (e.g. "1.") — parsed into the shared range
  // on every change, and re-synced from it when a dock drag sets it instead.
  const [startS, setStartS] = useState("0");
  const [endS, setEndS] = useState("");
  // Range values this component itself just emitted from typing. The sync
  // effect skips those echoes so it never clobbers a buffer mid-keystroke;
  // anything else (dock drags, chip clear, recording switch) re-syncs.
  const lastTyped = useRef<LoopRegion | null | undefined>(undefined);

  useEffect(() => {
    const echo = lastTyped.current !== undefined && sameRange(lastTyped.current, range);
    lastTyped.current = undefined;
    if (echo) return;
    if (range) {
      setStartS(String(range.a / 1000));
      setEndS(String(range.b / 1000));
    } else {
      setStartS("0");
      setEndS("");
    }
  }, [range]);

  const [expectText, setExpectText] = useState("");
  const [timeoutS, setTimeoutS] = useState(String(DEFAULT_TIMEOUT_S));

  const handleRecordingChange = (id: string) => {
    // MacroEditor resets the shared range on switch; reset the local buffers
    // here too, since a null→null range transition won't re-run the sync.
    setStartS("0");
    setEndS("");
    onSelectRecording(id);
  };

  // Parses the start/end second text fields into the shared range, rounding
  // to whole ms and rejecting (→ null, disabling Add) anything out of
  // [0, duration_ms] or with end <= start — mirrors segmentNodeFromRange's
  // own rounding.
  const applyTypedRange = (nextStartS: string, nextEndS: string) => {
    let next: LoopRegion | null = null;
    if (selected?.video) {
      const s = Number(nextStartS);
      const e = Number(nextEndS);
      if (Number.isFinite(s) && Number.isFinite(e)) {
        const a = Math.round(s * 1000);
        const b = Math.round(e * 1000);
        if (a >= 0 && b > a && b <= selected.video.duration_ms) next = { a, b };
      }
    }
    lastTyped.current = next;
    onRangeChange(next);
  };

  const handleStartChange = (value: string) => {
    setStartS(value);
    applyTypedRange(value, endS);
  };
  const handleEndChange = (value: string) => {
    setEndS(value);
    applyTypedRange(startS, value);
  };

  const segmentValid = selected !== null && range !== null && range.b > range.a;

  const handleAddSegment = () => {
    if (!segmentValid || !selected?.video || !range) return;
    onAdd(segmentNodeFromRange(selected, range.a, range.b));
  };

  const expectValid = expectText.trim().length > 0;
  const timeout = Number(timeoutS);
  const timeoutValid = Number.isFinite(timeout) && timeout >= MIN_TIMEOUT_S;

  const handleAddWait = () => {
    if (!expectValid) return;
    const expect = expectText.trim();
    // Same rounding concern as the segment ms values above.
    const timeoutMs = Math.round((timeoutValid ? timeout : DEFAULT_TIMEOUT_S) * 1000);
    const target: PerceptionTarget = {
      id: crypto.randomUUID(),
      name: expect,
      modality: "visual",
      region: { x: 0, y: 0, w: 1, h: 1 },
      kind: { type: "TextOcr", expect },
      created_at: Date.now(),
    };
    onAdd(waitNodeFromTarget(target, timeoutMs));
  };

  return (
    <div className="anp-root">
      <div className="anp-field">
        <span className="anp-label">Recording</span>
        <Select value={selectedRecordingId} onValueChange={handleRecordingChange}>
          <SelectTrigger
            aria-label="Recording"
            className="h-8 focus:ring-0 focus:ring-offset-0 focus-visible:ring-2"
          >
            <SelectValue placeholder="Select recording..." />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {recordingsWithVideo.map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  {r.name || r.id}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>

      <div className="anp-section">
        <div className="anp-title">
          <Film aria-hidden="true" />
          Add Segment
        </div>
        {selected ? (
          range ? (
            <div className="anp-chip">
              <span>
                {fmtS(range.a)}–{fmtS(range.b)} ·{" "}
                {eventsInRange(selected.events, segmentBasis(selected), range.a, range.b).length}{" "}
                events
              </span>
              <button
                type="button"
                className="anp-chip-clear"
                aria-label="Clear range"
                onClick={() => onRangeChange(null)}
              >
                ✕
              </button>
            </div>
          ) : (
            <div className="anp-summary">Drag on the timeline in the dock below to select a range</div>
          )
        ) : (
          <div className="anp-summary">Select a recording to carve a segment</div>
        )}
        <div className="anp-field-grid">
          <label className="anp-field">
            <span className="anp-label">Start (s)</span>
            <Input
              aria-label="Start (s)"
              className="h-8"
              type="number"
              value={startS}
              onChange={(e) => handleStartChange(e.target.value)}
            />
          </label>
          <label className="anp-field">
            <span className="anp-label">End (s)</span>
            <Input
              aria-label="End (s)"
              className="h-8"
              type="number"
              value={endS}
              onChange={(e) => handleEndChange(e.target.value)}
            />
          </label>
        </div>
        <button
          type="button"
          className="anp-add"
          disabled={!segmentValid}
          onClick={handleAddSegment}
        >
          <Plus aria-hidden="true" />
          Add Segment
        </button>
      </div>

      <div className="anp-section">
        <div className="anp-title">
          <ScanText aria-hidden="true" />
          Add Text Wait
        </div>
        <label className="anp-field">
          <span className="anp-label">Expected text</span>
          <Input
            aria-label="Expected text"
            className="h-8"
            value={expectText}
            onChange={(e) => setExpectText(e.target.value)}
            placeholder="Expected text"
          />
        </label>
        <label className="anp-field">
          <span className="anp-label">Timeout (s)</span>
          <Input
            aria-label="Timeout (s)"
            className="h-8"
            type="number"
            value={timeoutS}
            onChange={(e) => setTimeoutS(e.target.value)}
          />
        </label>
        <button type="button" className="anp-add" disabled={!expectValid} onClick={handleAddWait}>
          <Plus aria-hidden="true" />
          Add Text Wait
        </button>
      </div>

      <div className="anp-section">
        <div className="anp-title">
          <ImagePlus aria-hidden="true" />
          Add Visual Wait
        </div>
        <div className="anp-summary">
          {selected
            ? "Drag a box on the video frame in the dock below to add an image or color wait."
            : "Select a recording to add an image or color wait."}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Add chip styles**

Append to `src/components/studio/macros/macro-editor.css`:

```css
.anp-chip {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 5px 9px;
  border: 1px solid rgb(240 205 120 / 46%);
  border-radius: 7px;
  background: rgb(240 205 120 / 12%);
  color: var(--macro-text);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.anp-chip-clear {
  border: none;
  background: transparent;
  color: var(--macro-dim);
  font-size: 12px;
  cursor: pointer;
  padding: 0 2px;
}

.anp-chip-clear:hover {
  color: var(--macro-text);
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm vitest run src/components/studio/macros/AddNodePanel.test.tsx`
Expected: PASS (10 tests). Note MacroEditor.tsx will have TypeScript errors right now (old props) — that's Task 4; only this test file must pass here.

- [ ] **Step 7: Lint and commit**

```bash
pnpm biome check --write src/components/studio/macros/AddNodePanel.tsx src/components/studio/macros/AddNodePanel.test.tsx
git add src/components/studio/macros/AddNodePanel.tsx src/components/studio/macros/AddNodePanel.test.tsx src/components/studio/macros/macro-editor.css src/components/ui/input.tsx package.json pnpm-lock.yaml
git commit -m "Make AddNodePanel a controlled forms column with shared range

Claude-Session: https://claude.ai/code/session_017i9yz2dmA4pvXWkwbV577L"
```

---

### Task 4: MacroEditor — resizable layout, state lift, dock wiring

**Files:**
- Create (CLI): `src/components/ui/resizable.tsx`
- Modify: `src/components/studio/macros/MacroEditor.tsx`
- Modify: `src/components/studio/macros/macro-editor.css`
- Test: `src/components/studio/macros/MacroEditor.test.tsx`

**Interfaces:**
- Consumes: `AuthoringDock` (Task 2 props), `AddNodePanel` (Task 3 props), shadcn `ResizablePanelGroup`/`ResizablePanel`/`ResizableHandle`, `waitNodeFromTarget` from `@/lib/macro-wait`, `LoopRegion` from `@/components/studio/StudioTimeline`.
- Produces: no API change — `MacroEditorProps` is unchanged.

- [ ] **Step 1: Install the shadcn Resizable**

```bash
pnpm dlx shadcn@latest add resizable
```

Expected: `Created 1 file: src/components/ui/resizable.tsx` (installs `react-resizable-panels`).

- [ ] **Step 2: Write the failing tests**

In `src/components/studio/macros/MacroEditor.test.tsx`, add after the existing `MacroCanvas` mock (before the `import { MacroEditor } ...` line):

```tsx
// The real AuthoringDock renders StudioPlayer/StudioTimeline (video, drag
// math) — covered by its own test file. Here a stub stands in for "the user
// dragged a range / saved a target in the dock" so the shared-state wiring
// through MacroEditor is what's under test.
vi.mock("@/components/studio/macros/AuthoringDock", () => ({
  AuthoringDock: ({
    onRangeChange,
    onSaveTarget,
  }: {
    onRangeChange: (r: { a: number; b: number } | null) => void;
    onSaveTarget: (target: unknown, timestampMs: number) => Promise<void>;
  }) => (
    <div data-testid="authoring-dock">
      <button type="button" onClick={() => onRangeChange({ a: 2000, b: 4000 })}>
        Simulate dock range
      </button>
      <button
        type="button"
        onClick={() =>
          onSaveTarget(
            {
              id: "t-img",
              name: "Target",
              modality: "visual",
              region: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
              kind: { type: "TemplateMatch", image: "", threshold: 0.8, source_px: [0, 0] },
              created_at: 1,
            },
            4200,
          )
        }
      >
        Simulate dock image save
      </button>
    </div>
  ),
}));
```

Extend the fake `invoke` mock's `switch` with a `save_target` case (it currently returns `undefined` for unknown commands, which would make `captureImageWait` throw):

```tsx
      case "save_target": {
        const target = args?.target as { id: string; kind: Record<string, unknown> };
        return {
          id: args?.recordingId,
          targets: [{ ...target, kind: { ...target.kind, image: "targets/rec-1/t-img.png" } }],
        };
      }
```

Add a recording fixture next to the existing empty `recordings` array (import `InputEventType, type InputEvent` in the types import):

```tsx
function mkEvent(key: string, timestamp: number): InputEvent {
  return { type: InputEventType.KeyPress, key, timestamp };
}

const recordingWithVideo: Recording = {
  id: "rec-1",
  name: "Recording One",
  events: [
    mkEvent("e0", 1000),
    mkEvent("e1", 2000),
    mkEvent("e2", 3000),
    mkEvent("e3", 4000),
    mkEvent("e4", 5000),
  ],
  created_at: 500,
  playback_speed: 1,
  video: {
    path: "/tmp/rec-1.mp4",
    start_ms: 1000,
    duration_ms: 5000,
    width: 1920,
    height: 1080,
    fps: 30,
    has_audio: false,
  },
};
```

And a helper + new tests inside the `describe`:

```tsx
  async function selectRecording(name: string | RegExp) {
    await userEvent.click(screen.getByRole("combobox", { name: /recording/i }));
    await userEvent.click(await screen.findByRole("option", { name }));
  }

  it("shows the authoring dock only after a recording with video is selected", async () => {
    render(<Wrapper recordings={[recordingWithVideo]} />);
    await screen.findByText(/0 node/i);
    expect(screen.queryByTestId("authoring-dock")).not.toBeInTheDocument();

    await selectRecording("Recording One");
    expect(screen.getByTestId("authoring-dock")).toBeInTheDocument();
  });

  it("a dock range drives the sidebar summary and produces a matching Segment node", async () => {
    render(<Wrapper recordings={[recordingWithVideo]} />);
    await screen.findByText(/0 node/i);
    await selectRecording("Recording One");

    await userEvent.click(screen.getByRole("button", { name: /simulate dock range/i }));
    // rel [2000,4000] over basis 1000 → e2, e3, e4.
    expect(screen.getByText(/0:02–0:04 · 3 events/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /add segment/i }));
    expect(await screen.findByText(/1 node/i)).toBeInTheDocument();
  });

  it("a dock image save captures via save_target and adds a WaitFor node", async () => {
    render(<Wrapper recordings={[recordingWithVideo]} />);
    await screen.findByText(/0 node/i);
    await selectRecording("Recording One");

    await userEvent.click(screen.getByRole("button", { name: /simulate dock image save/i }));
    expect(await screen.findByText(/1 node/i)).toBeInTheDocument();
  });
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm vitest run src/components/studio/macros/MacroEditor.test.tsx`
Expected: FAIL — MacroEditor still passes old props to AddNodePanel (TypeScript/render errors) and renders no dock.

- [ ] **Step 4: Rewire MacroEditor**

In `src/components/studio/macros/MacroEditor.tsx`:

Add imports:

```tsx
import { AuthoringDock } from "@/components/studio/macros/AuthoringDock";
import type { LoopRegion } from "@/components/studio/StudioTimeline";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { waitNodeFromTarget } from "@/lib/macro-wait";
```

Add shared authoring state after the existing `confirmDeleteId` state:

```tsx
  // Shared authoring context: which recording the Add Segment / Visual Wait
  // flows operate on, and the segment range dragged on the dock's timeline
  // (video-relative ms). Owned here because the sidebar forms and the
  // AuthoringDock both read and write them.
  const [authoringRecordingId, setAuthoringRecordingId] = useState("");
  const [authoringRange, setAuthoringRange] = useState<LoopRegion | null>(null);
  const authoringRecording =
    recordings.find((r) => r.id === authoringRecordingId && r.video) ?? null;

  const handleSelectRecording = useCallback((id: string) => {
    setAuthoringRecordingId(id);
    setAuthoringRange(null);
  }, []);
```

Add the dock's node-building callbacks after `sampleColor` (this logic moves here from the old AddNodePanel — Image targets need the `save_target` capture round-trip, Color targets wrap as-is; a capture rejection propagates so no node is added):

```tsx
  const handleDockSaveTarget = useCallback(
    async (target: PerceptionTarget, timestampMs: number) => {
      if (!authoringRecording) return;
      if (target.kind.type === "TemplateMatch") {
        const captured = await captureImageWait(authoringRecording.id, target, timestampMs);
        handleAddNode(waitNodeFromTarget(captured));
      } else {
        handleAddNode(waitNodeFromTarget(target));
      }
    },
    [authoringRecording, captureImageWait, handleAddNode],
  );

  const handleDockSampleColor = useCallback(
    (region: Region, timestampMs: number): Promise<[number, number, number]> =>
      authoringRecording
        ? sampleColor(authoringRecording.id, region, timestampMs)
        : Promise.resolve<[number, number, number]>([0, 0, 0]),
    [authoringRecording, sampleColor],
  );
```

(`handleAddNode` is declared above these — keep declaration order so the deps exist.)

Replace the `<div className="macro-editor-main">…</div>` block:

```tsx
      <div className="macro-editor-main">
        <ResizablePanelGroup direction="horizontal">
          <ResizablePanel defaultSize={22} minSize={15} maxSize={35}>
            <aside className="macro-editor-sidebar">
              <div className="macro-editor-sidebar-inner">
                <AddNodePanel
                  recordings={recordings}
                  selectedRecordingId={authoringRecordingId}
                  onSelectRecording={handleSelectRecording}
                  range={authoringRange}
                  onRangeChange={setAuthoringRange}
                  onAdd={handleAddNode}
                />
              </div>
            </aside>
          </ResizablePanel>
          <ResizableHandle />
          <ResizablePanel defaultSize={78}>
            <ResizablePanelGroup direction="vertical">
              <ResizablePanel id="macro-canvas" order={1} defaultSize={60} minSize={30}>
                <section className="macro-editor-canvas-pane" aria-label="Macro canvas">
                  <MacroCanvas
                    doc={workingDoc}
                    liveNodeId={liveNodeId}
                    failedNodeId={isStoppedRun ? null : (failed?.nodeId ?? null)}
                    onChange={handleCanvasChange}
                  />
                </section>
              </ResizablePanel>
              {authoringRecording && (
                <>
                  <ResizableHandle />
                  <ResizablePanel id="authoring-dock" order={2} defaultSize={40} minSize={20}>
                    <AuthoringDock
                      recording={authoringRecording}
                      range={authoringRange}
                      onRangeChange={setAuthoringRange}
                      onSaveTarget={handleDockSaveTarget}
                      onSampleColor={handleDockSampleColor}
                    />
                  </ResizablePanel>
                </>
              )}
            </ResizablePanelGroup>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
```

(The conditional dock panel needs `id` + `order` on BOTH vertical panels so react-resizable-panels keeps layout stable as it mounts/unmounts.)

- [ ] **Step 5: Update the layout CSS**

In `src/components/studio/macros/macro-editor.css`:

Replace the `.macro-editor-main` rule:

```css
.macro-editor-main {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
}
```

Add `height: 100%` to `.macro-editor-sidebar` and `.macro-editor-canvas-pane` (keep their other declarations):

```css
.macro-editor-sidebar {
  height: 100%;
  min-height: 0;
  overflow-y: auto;
  border-right: 1px solid var(--macro-line);
  background: linear-gradient(180deg, rgb(17 17 17 / 88%), rgb(0 0 0 / 92%)), var(--macro-panel);
}
```

```css
.macro-editor-canvas-pane {
  height: 100%;
  min-width: 0;
  min-height: 0;
  position: relative;
  background: var(--macro-well);
}
```

In the narrow-viewport `@media` block near the bottom of the file, DELETE the now-obsolete grid override and sidebar stacking rules (the panels handle sizing at any width):

```css
  .macro-editor-main {
    grid-template-columns: 1fr;
    grid-template-rows: auto minmax(420px, 1fr);
  }

  .macro-editor-sidebar {
    max-height: 42vh;
    border-right: 0;
    border-bottom: 1px solid var(--macro-line);
  }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm vitest run src/components/studio/macros/MacroEditor.test.tsx`
Expected: PASS — the 3 new tests plus every pre-existing test (dirty/save/run wiring must be unaffected). If PanelGroup warns about missing sizes in jsdom, it's non-fatal; failures to fix would be real render errors.

- [ ] **Step 7: Typecheck + full suite + lint, then commit**

```bash
pnpm tsc --noEmit
pnpm vitest run
pnpm biome check --write src/components/studio/macros/MacroEditor.tsx src/components/studio/macros/MacroEditor.test.tsx
```

Expected: tsc exit 0; all test files pass (StudioEditor's timeline usage is untouched by default `rangeWord`).

```bash
git add src/components/studio/macros/MacroEditor.tsx src/components/studio/macros/MacroEditor.test.tsx src/components/studio/macros/macro-editor.css src/components/ui/resizable.tsx package.json pnpm-lock.yaml
git commit -m "Tile the macro editor: resizable sidebar, canvas, and authoring dock

Claude-Session: https://claude.ai/code/session_017i9yz2dmA4pvXWkwbV577L"
```

---

### Task 5: End-to-end verification in the running app

**Files:** none (verification only; fix-ups commit separately if needed).

- [ ] **Step 1: Full gates**

```bash
pnpm tsc --noEmit && pnpm vitest run && pnpm biome check src
```

Expected: all clean.

- [ ] **Step 2: Drive the real app**

Run `pnpm tauri dev`, open the Macros view, and verify against the spec:

1. Sidebar shows Recording select on top; dragging the sidebar/canvas divider resizes it within bounds.
2. No dock and full-height canvas before selecting a recording.
3. Selecting a recording opens the dock; the horizontal divider drags.
4. Dragging on the dock timeline: chip + Start/End inputs update in the sidebar; playback loops the selected range; timeline copy says "drag to select a range" / "selection 0:0a–0:0b ✕".
5. Add Segment adds a node to the canvas.
6. Dragging a box on the dock's video frame opens the Image/Color popover; saving adds a WaitFor node.
7. Add Text Wait still works; all inputs render in the shadcn style.
8. Main Studio (recordings) view timeline still says "drag to loop a range".

- [ ] **Step 3: Report**

Report each check's outcome to the user with screenshots if practical. Fix anything broken before claiming done (superpowers:verification-before-completion).
