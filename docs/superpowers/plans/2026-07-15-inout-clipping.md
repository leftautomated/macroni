# In/Out Clipping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mark a segment at the playhead while watching — I/O keys and In/Out buttons in the AuthoringDock write the shared range, and Enter / an in-dock Add Segment button turns it into a node without visiting the sidebar.

**Architecture:** All interaction lives in `AuthoringDock` (mark handlers computed from the playhead it already tracks, one window keydown listener via a handler ref, a clip row under the transport bar). `MacroEditor` contributes one callback (`onAddSegment`) that reuses `segmentNodeFromRange` exactly as the sidebar path does. `StudioPlayer`, `StudioTimeline`, `AddNodePanel` behavior, and the backend are untouched.

**Tech Stack:** React 18 + TypeScript, vitest + @testing-library/react (jsdom), biome, pnpm.

**Spec:** `docs/superpowers/specs/2026-07-15-inout-clipping-design.md`

## Global Constraints

- **StudioPlayer, StudioTimeline, and the backend are untouched.** `AddNodePanel` changes only by swapping its private `fmtS` for the shared formatter (no behavior change).
- Marks write the existing shared range (`onRangeChange`) — loop preview, timeline highlight, and sidebar sync are inherited, never reimplemented.
- Mark semantics (playhead `p = Math.round(videoS * 1000)`, duration `d = video.duration_ms`): In → `{a: p, b: range && range.b > p ? range.b : d}`; Out → `{a: range && range.a < p ? range.a : 0, b: p}`; a mark that would produce `b <= a` no-ops (no `onRangeChange` call).
- Keydown listener: window-level while the dock is mounted; ignores events when meta/ctrl/alt is held or when the target is an `<input>`, `<textarea>`, `<select>`, or contentEditable element; `Enter`/`Escape` call `preventDefault()` only when they act (a range exists).
- Biome style: double quotes, semicolons, `type` keyword on type-only imports. Run `pnpm biome check --write <files>` before committing.
- Single-file test runs: `pnpm vitest run <file>`.
- Every commit message ends with:
  `Claude-Session: https://claude.ai/code/session_017i9yz2dmA4pvXWkwbV577L`

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/time-format.ts` (create) | Shared `fmtMmSs(ms)` — one m:ss formatter instead of per-component copies |
| `src/lib/time-format.test.ts` (create) | Its unit test |
| `src/components/studio/macros/AuthoringDock.tsx` (modify) | Mark handlers, keydown listener, clip row (In/Out buttons + chip + Add) |
| `src/components/studio/macros/AuthoringDock.test.tsx` (modify) | Mark/keyboard/chip tests |
| `src/components/studio/macros/AddNodePanel.tsx` (modify) | Drop private `fmtS`, import `fmtMmSs` |
| `src/components/studio/macros/macro-editor.css` (modify) | `.adock-cliprow` / `.adock-mark` / `.adock-add` styles |
| `src/components/studio/macros/MacroEditor.tsx` (modify) | `handleAddSegmentFromDock` → `onAddSegment` prop |
| `src/components/studio/macros/MacroEditor.test.tsx` (modify) | Dock-add integration test |

---

### Task 1: AuthoringDock In/Out marking, keyboard, and clip row

**Files:**
- Create: `src/lib/time-format.ts`, `src/lib/time-format.test.ts`
- Modify: `src/components/studio/macros/AuthoringDock.tsx` (full replacement below)
- Modify: `src/components/studio/macros/AddNodePanel.tsx` (formatter swap only)
- Modify: `src/components/studio/macros/macro-editor.css` (append styles)
- Test: `src/components/studio/macros/AuthoringDock.test.tsx` (full replacement below)

**Interfaces:**
- Consumes: existing `AuthoringDockProps`; `eventsInRange`/`segmentBasis` from `@/lib/macro-segment`; `LoopRegion` from `@/components/studio/StudioTimeline`.
- Produces: `AuthoringDockProps` gains **required** `onAddSegment: () => void` (Task 2 wires it). `fmtMmSs(ms: number): string` in `@/lib/time-format`.

- [ ] **Step 1: Create the shared formatter and its test**

`src/lib/time-format.ts`:

```ts
/** Format video-relative milliseconds as m:ss (floored to whole seconds). */
export function fmtMmSs(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
```

`src/lib/time-format.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { fmtMmSs } from "./time-format";

describe("fmtMmSs", () => {
  it("formats ms as m:ss, flooring and clamping negatives", () => {
    expect(fmtMmSs(0)).toBe("0:00");
    expect(fmtMmSs(2999)).toBe("0:02");
    expect(fmtMmSs(65_000)).toBe("1:05");
    expect(fmtMmSs(-50)).toBe("0:00");
  });
});
```

Run: `pnpm vitest run src/lib/time-format.test.ts` — Expected: PASS (1 test).

- [ ] **Step 2: Swap AddNodePanel to the shared formatter**

In `src/components/studio/macros/AddNodePanel.tsx`:
- Delete the private `fmtS` function (lines ~31–34, `function fmtS(ms: number): string { ... }`).
- Add import: `import { fmtMmSs } from "@/lib/time-format";` (biome will sort it).
- Replace the two chip usages `fmtS(range.a)` / `fmtS(range.b)` with `fmtMmSs(range.a)` / `fmtMmSs(range.b)`.

Run: `pnpm vitest run src/components/studio/macros/AddNodePanel.test.tsx` — Expected: PASS (all 10; behavior identical).

- [ ] **Step 3: Write the failing dock tests**

Replace `src/components/studio/macros/AuthoringDock.test.tsx` entirely with:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { InputEventType, type InputEvent, type PerceptionTarget, type Recording } from "@/types";

// The dock's unit under test is its wiring: range→loopRegion conversion,
// drag→rounded onRangeChange, In/Out marking from the playhead, and
// passthrough of the target-authoring hooks. StudioPlayer is stubbed to
// expose those props (including onTimeUpdate so tests can move the
// playhead); StudioTimeline renders for real so drag math is exercised.
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
    onTimeUpdate,
  }: {
    loopRegion?: { a: number; b: number } | null;
    onSaveTarget?: (target: PerceptionTarget, timestampMs: number) => Promise<void>;
    onTimeUpdate: (seconds: number) => void;
  }) => (
    <div data-testid="player-stub">
      <div>loop: {loopRegion ? `${loopRegion.a}-${loopRegion.b}` : "none"}</div>
      <button
        type="button"
        onClick={() => onSaveTarget?.(fixtures.target as PerceptionTarget, 4200)}
      >
        Simulate save
      </button>
      <button type="button" onClick={() => onTimeUpdate(1)}>
        Seek 1s
      </button>
      <button type="button" onClick={() => onTimeUpdate(3)}>
        Seek 3s
      </button>
      <button type="button" onClick={() => onTimeUpdate(5)}>
        Seek 5s
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
  onAddSegment: () => {},
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

  describe("In/Out marking", () => {
    it("I with no range marks playhead→end; O with no range marks start→playhead", async () => {
      const onRangeChange = vi.fn();
      render(<AuthoringDock {...baseProps} onRangeChange={onRangeChange} />);

      await userEvent.click(screen.getByRole("button", { name: "Seek 1s" }));
      fireEvent.keyDown(window, { key: "i" });
      expect(onRangeChange).toHaveBeenLastCalledWith({ a: 1000, b: 5000 });

      fireEvent.keyDown(window, { key: "o" });
      expect(onRangeChange).toHaveBeenLastCalledWith({ a: 0, b: 1000 });
    });

    it("In keeps a later Out, and re-anchors to the end past it", async () => {
      const onRangeChange = vi.fn();
      const { rerender } = render(
        <AuthoringDock {...baseProps} range={{ a: 2000, b: 4000 }} onRangeChange={onRangeChange} />,
      );
      await userEvent.click(screen.getByRole("button", { name: "Seek 1s" }));
      fireEvent.keyDown(window, { key: "i" });
      expect(onRangeChange).toHaveBeenLastCalledWith({ a: 1000, b: 4000 });

      // Existing Out (500ms) is before the playhead → In extends to the end.
      rerender(
        <AuthoringDock {...baseProps} range={{ a: 0, b: 500 }} onRangeChange={onRangeChange} />,
      );
      fireEvent.keyDown(window, { key: "i" });
      expect(onRangeChange).toHaveBeenLastCalledWith({ a: 1000, b: 5000 });
    });

    it("Out keeps an earlier In, and re-anchors to 0 before it", async () => {
      const onRangeChange = vi.fn();
      render(
        <AuthoringDock {...baseProps} range={{ a: 2000, b: 4000 }} onRangeChange={onRangeChange} />,
      );
      await userEvent.click(screen.getByRole("button", { name: "Seek 3s" }));
      fireEvent.keyDown(window, { key: "o" });
      expect(onRangeChange).toHaveBeenLastCalledWith({ a: 2000, b: 3000 });

      // Playhead (1s) is before the existing In (2s) → Out re-anchors to 0.
      await userEvent.click(screen.getByRole("button", { name: "Seek 1s" }));
      fireEvent.keyDown(window, { key: "o" });
      expect(onRangeChange).toHaveBeenLastCalledWith({ a: 0, b: 1000 });
    });

    it("marks that would produce an empty range no-op", async () => {
      const onRangeChange = vi.fn();
      render(<AuthoringDock {...baseProps} onRangeChange={onRangeChange} />);

      // Out at playhead 0 → b == a == 0.
      fireEvent.keyDown(window, { key: "o" });
      // In at the end of the video → a == b == duration.
      await userEvent.click(screen.getByRole("button", { name: "Seek 5s" }));
      fireEvent.keyDown(window, { key: "i" });

      expect(onRangeChange).not.toHaveBeenCalled();
    });

    it("ignores keys typed into form fields and modifier chords", async () => {
      const onRangeChange = vi.fn();
      render(
        <>
          <AuthoringDock {...baseProps} onRangeChange={onRangeChange} />
          <input aria-label="Some sidebar field" />
        </>,
      );
      await userEvent.click(screen.getByRole("button", { name: "Seek 1s" }));

      fireEvent.keyDown(screen.getByLabelText("Some sidebar field"), { key: "i" });
      fireEvent.keyDown(window, { key: "i", metaKey: true });
      fireEvent.keyDown(window, { key: "o", ctrlKey: true });

      expect(onRangeChange).not.toHaveBeenCalled();
    });

    it("the In/Out buttons mark exactly like the keys", async () => {
      const onRangeChange = vi.fn();
      render(<AuthoringDock {...baseProps} onRangeChange={onRangeChange} />);
      await userEvent.click(screen.getByRole("button", { name: "Seek 1s" }));

      await userEvent.click(screen.getByRole("button", { name: /mark in/i }));
      expect(onRangeChange).toHaveBeenLastCalledWith({ a: 1000, b: 5000 });

      await userEvent.click(screen.getByRole("button", { name: /mark out/i }));
      expect(onRangeChange).toHaveBeenLastCalledWith({ a: 0, b: 1000 });
    });
  });

  describe("clip row", () => {
    it("Enter adds only when a range exists; Escape clears it", () => {
      const onAddSegment = vi.fn();
      const onRangeChange = vi.fn();
      const { rerender } = render(
        <AuthoringDock {...baseProps} onAddSegment={onAddSegment} onRangeChange={onRangeChange} />,
      );

      fireEvent.keyDown(window, { key: "Enter" });
      fireEvent.keyDown(window, { key: "Escape" });
      expect(onAddSegment).not.toHaveBeenCalled();
      expect(onRangeChange).not.toHaveBeenCalled();

      rerender(
        <AuthoringDock
          {...baseProps}
          range={{ a: 0, b: 2000 }}
          onAddSegment={onAddSegment}
          onRangeChange={onRangeChange}
        />,
      );
      fireEvent.keyDown(window, { key: "Enter" });
      expect(onAddSegment).toHaveBeenCalledTimes(1);
      fireEvent.keyDown(window, { key: "Escape" });
      expect(onRangeChange).toHaveBeenCalledWith(null);
    });

    it("renders the chip with the event count, a clear button, and Add Segment", async () => {
      const onAddSegment = vi.fn();
      const onRangeChange = vi.fn();
      render(
        <AuthoringDock
          {...baseProps}
          range={{ a: 0, b: 2000 }}
          onAddSegment={onAddSegment}
          onRangeChange={onRangeChange}
        />,
      );

      // Events at rel 100 and 292 are both inside [0, 2000].
      expect(screen.getByText(/0:00–0:02 · 2 events/)).toBeInTheDocument();

      await userEvent.click(screen.getByRole("button", { name: /add segment/i }));
      expect(onAddSegment).toHaveBeenCalledTimes(1);

      await userEvent.click(screen.getByRole("button", { name: /clear range/i }));
      expect(onRangeChange).toHaveBeenCalledWith(null);
    });

    it("shows no chip or Add button without a range", () => {
      render(<AuthoringDock {...baseProps} />);
      expect(screen.queryByRole("button", { name: /add segment/i })).not.toBeInTheDocument();
      expect(screen.queryByText(/events/)).not.toBeInTheDocument();
    });
  });
});
```

- [ ] **Step 4: Run tests to verify the new ones fail**

Run: `pnpm vitest run src/components/studio/macros/AuthoringDock.test.tsx`
Expected: FAIL — TypeScript error on the new required `onAddSegment` prop and/or missing Seek buttons/mark handlers; the 4 pre-existing tests may still pass.

- [ ] **Step 5: Implement the dock changes**

Replace `src/components/studio/macros/AuthoringDock.tsx` entirely with:

```tsx
import { useEffect, useRef, useState } from "react";
import type { KindOption } from "@/components/studio/CreateTargetPopover";
import { StudioPlayer, type StudioPlayerHandle } from "@/components/studio/StudioPlayer";
import { type LoopRegion, StudioTimeline } from "@/components/studio/StudioTimeline";
import { useVideoAssetUrl } from "@/hooks/useVideoAssetUrl";
import { eventsInRange, segmentBasis } from "@/lib/macro-segment";
import { fmtMmSs } from "@/lib/time-format";
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
  /** Build + add a Segment node from the current shared range. */
  onAddSegment: () => void;
  onSaveTarget: (target: PerceptionTarget, timestampMs: number) => Promise<void>;
  onSampleColor: (region: Region, timestampMs: number) => Promise<[number, number, number]>;
}

/**
 * Bottom authoring dock for the macro editor: the real StudioPlayer and
 * StudioTimeline at full width, exactly as the main studio pairs them.
 * Segments come from dragging on the timeline OR marking In/Out at the
 * playhead (I/O keys or the clip-row buttons); either way the shared range
 * loop-previews on the player. Enter adds the segment, Escape clears.
 * Dragging a box on the frame authors an Image/Color wait through the
 * player's existing popover flow.
 */
export function AuthoringDock({
  recording,
  range,
  onRangeChange,
  onAddSegment,
  onSaveTarget,
  onSampleColor,
}: AuthoringDockProps) {
  const playerRef = useRef<StudioPlayerHandle>(null);
  const [videoS, setVideoS] = useState(0);
  // The player's transport bar renders into the timeline column (same
  // controlsHost pattern as StudioEditor), so the video fills the left pane
  // and scrub/transport/timeline stack together on the right.
  const [controlsHost, setControlsHost] = useState<HTMLElement | null>(null);
  const { url } = useVideoAssetUrl(recording.video);

  const durationMs = recording.video?.duration_ms ?? 0;

  // Marks always emit a complete, valid range (b > a, whole ms): a lone In
  // runs to the end of the video, a lone Out starts at 0, and a mark that
  // would produce an empty range no-ops.
  const markIn = () => {
    const p = Math.round(videoS * 1000);
    const b = range && range.b > p ? range.b : durationMs;
    if (b > p) onRangeChange({ a: p, b });
  };
  const markOut = () => {
    const p = Math.round(videoS * 1000);
    const a = range && range.a < p ? range.a : 0;
    if (p > a) onRangeChange({ a, b: p });
  };

  // I/O/Enter/Escape while the dock is open. The window listener is bound
  // once; the ref indirection lets it read the latest playhead/range without
  // re-binding on every onTimeUpdate tick. Form fields and modifier chords
  // are ignored so typing in the sidebar (or app shortcuts) never marks, and
  // Enter/Escape are only claimed when they act.
  const keyHandler = useRef<(e: KeyboardEvent) => void>(noop);
  keyHandler.current = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (
      t instanceof HTMLElement &&
      (t.tagName === "INPUT" ||
        t.tagName === "TEXTAREA" ||
        t.tagName === "SELECT" ||
        t.isContentEditable)
    ) {
      return;
    }
    if (e.key === "i" || e.key === "I") {
      markIn();
    } else if (e.key === "o" || e.key === "O") {
      markOut();
    } else if (e.key === "Enter" && range) {
      e.preventDefault();
      onAddSegment();
    } else if (e.key === "Escape" && range) {
      e.preventDefault();
      onRangeChange(null);
    }
  };
  useEffect(() => {
    const listen = (e: KeyboardEvent) => keyHandler.current(e);
    window.addEventListener("keydown", listen);
    return () => window.removeEventListener("keydown", listen);
  }, []);

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
          showReplay={false}
          controlsHost={controlsHost}
          loopRegion={range ? { a: range.a / 1000, b: range.b / 1000 } : null}
          onSaveTarget={onSaveTarget}
          onSampleColor={onSampleColor}
          popoverKinds={DOCK_POPOVER_KINDS}
        />
      </div>
      <div className="adock-timeline">
        <div ref={setControlsHost} className="adock-controls" />
        <div className="adock-cliprow">
          <button
            type="button"
            className="adock-mark"
            title="Mark In at the playhead (I)"
            aria-label="Mark In"
            onClick={markIn}
          >
            ⌈ In
          </button>
          <button
            type="button"
            className="adock-mark"
            title="Mark Out at the playhead (O)"
            aria-label="Mark Out"
            onClick={markOut}
          >
            ⌋ Out
          </button>
          {range && (
            <>
              <div className="anp-chip adock-chip">
                <span>
                  {fmtMmSs(range.a)}–{fmtMmSs(range.b)} ·{" "}
                  {eventsInRange(recording.events, segmentBasis(recording), range.a, range.b).length}{" "}
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
              <button
                type="button"
                className="adock-add"
                title="Add this range as a Segment node (Enter)"
                onClick={onAddSegment}
              >
                + Add Segment
              </button>
            </>
          )}
        </div>
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

- [ ] **Step 6: Append the clip-row styles**

Append to `src/components/studio/macros/macro-editor.css`:

```css
.adock-cliprow {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}

.adock-mark {
  border: 1px solid var(--macro-line-strong);
  border-radius: 6px;
  padding: 2px 9px;
  background: rgb(255 255 255 / 5%);
  color: var(--macro-text);
  font-size: 11px;
  cursor: pointer;
}

.adock-mark:hover {
  background: rgb(255 255 255 / 10%);
}

.adock-chip {
  padding: 2px 9px;
}

.adock-add {
  border: 1px solid rgb(240 205 120 / 46%);
  border-radius: 6px;
  padding: 2px 10px;
  background: rgb(240 205 120 / 14%);
  color: #f0cd78;
  font-size: 11px;
  cursor: pointer;
}

.adock-add:hover {
  background: rgb(240 205 120 / 24%);
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm vitest run src/components/studio/macros/AuthoringDock.test.tsx src/lib/time-format.test.ts src/components/studio/macros/AddNodePanel.test.tsx`
Expected: PASS (13 dock + 1 formatter + 10 panel). NOTE: MacroEditor.tsx will fail `tsc` until Task 2 supplies `onAddSegment` — that's expected; do not gate this task on the whole-project typecheck.

- [ ] **Step 8: Lint and commit**

```bash
pnpm biome check --write src/lib/time-format.ts src/lib/time-format.test.ts src/components/studio/macros/AuthoringDock.tsx src/components/studio/macros/AuthoringDock.test.tsx src/components/studio/macros/AddNodePanel.tsx
git add src/lib/time-format.ts src/lib/time-format.test.ts src/components/studio/macros/AuthoringDock.tsx src/components/studio/macros/AuthoringDock.test.tsx src/components/studio/macros/AddNodePanel.tsx src/components/studio/macros/macro-editor.css
git commit -m "Add In/Out clipping to the authoring dock

Mark a segment at the playhead while watching: I/O keys and clip-row
buttons write the shared range (lone In runs to the end, lone Out from
0, empty ranges no-op), Enter adds, Escape clears. Extracts the shared
m:ss formatter to lib/time-format.

Claude-Session: https://claude.ai/code/session_017i9yz2dmA4pvXWkwbV577L"
```

---

### Task 2: MacroEditor wires onAddSegment

**Files:**
- Modify: `src/components/studio/macros/MacroEditor.tsx`
- Test: `src/components/studio/macros/MacroEditor.test.tsx`

**Interfaces:**
- Consumes: Task 1's required `AuthoringDockProps.onAddSegment: () => void`; `segmentNodeFromRange(recording, startMs, endMs)` from `@/lib/macro-segment`; existing `authoringRecording` / `authoringRange` / `handleAddNode` in MacroEditor.
- Produces: no API change (`MacroEditorProps` unchanged).

- [ ] **Step 1: Write the failing test**

In `src/components/studio/macros/MacroEditor.test.tsx`, extend the AuthoringDock mock: add `onAddSegment` to the stub's props type and a trigger button inside the stub's div (keep the existing buttons):

```tsx
    onAddSegment,
```
(added to the destructured props, typed `onAddSegment: () => void;`), and in the JSX:

```tsx
      <button type="button" onClick={() => onAddSegment()}>
        Simulate dock add segment
      </button>
```

Then add the test (inside the existing `describe`, after the dock-range test; `selectRecording` and `recordingWithVideo` already exist):

```tsx
  it("the dock's Add Segment builds the same node as the sidebar path", async () => {
    render(<Wrapper recordings={[recordingWithVideo]} />);
    await screen.findByText(/0 node/i);
    await selectRecording("Recording One");

    await userEvent.click(screen.getByRole("button", { name: /simulate dock range/i }));
    await userEvent.click(screen.getByRole("button", { name: /simulate dock add segment/i }));

    expect(await screen.findByText(/1 node/i)).toBeInTheDocument();
    // rel [2000,4000] over basis 1000 → e2, e3, e4 (same invariant as the
    // sidebar-path test; the canvas stub renders the built node's count).
    expect(screen.getByText("segment events: 3")).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/components/studio/macros/MacroEditor.test.tsx`
Expected: FAIL — the new test can't find "Simulate dock add segment" wired to anything real (and `tsc` on MacroEditor.tsx is failing since Task 1 made `onAddSegment` required).

- [ ] **Step 3: Wire the callback**

In `src/components/studio/macros/MacroEditor.tsx`:

Add the import (MacroEditor.tsx has no existing `@/lib/macro-segment` import; biome will sort it):

```tsx
import { segmentNodeFromRange } from "@/lib/macro-segment";
```

Add after `handleDockSampleColor` (both `authoringRecording` and `handleAddNode` are declared above):

```tsx
  // The dock's Enter / "+ Add Segment" — identical node construction to the
  // sidebar's Add Segment button, so the two paths can never diverge.
  const handleAddSegmentFromDock = useCallback(() => {
    if (!authoringRecording || !authoringRange || authoringRange.b <= authoringRange.a) return;
    handleAddNode(segmentNodeFromRange(authoringRecording, authoringRange.a, authoringRange.b));
  }, [authoringRecording, authoringRange, handleAddNode]);
```

And pass it on the dock element:

```tsx
                    <AuthoringDock
                      key={authoringRecording.id}
                      recording={authoringRecording}
                      range={authoringRange}
                      onRangeChange={setAuthoringRange}
                      onAddSegment={handleAddSegmentFromDock}
                      onSaveTarget={handleDockSaveTarget}
                      onSampleColor={handleDockSampleColor}
                    />
```

- [ ] **Step 4: Run tests + full gates**

Run: `pnpm vitest run src/components/studio/macros/MacroEditor.test.tsx`
Expected: PASS (all, including the new test).

Run: `pnpm tsc --noEmit && pnpm vitest run`
Expected: tsc exit 0; full suite green (this closes the temporary Task 1 typecheck gap).

- [ ] **Step 5: Lint and commit**

```bash
pnpm biome check --write src/components/studio/macros/MacroEditor.tsx src/components/studio/macros/MacroEditor.test.tsx
git add src/components/studio/macros/MacroEditor.tsx src/components/studio/macros/MacroEditor.test.tsx
git commit -m "Wire the dock's Add Segment through MacroEditor

Claude-Session: https://claude.ai/code/session_017i9yz2dmA4pvXWkwbV577L"
```

---

### Task 3: End-to-end verification

**Files:** none (verification only; fix-ups commit separately if needed).

- [ ] **Step 1: Full gates**

```bash
pnpm tsc --noEmit && pnpm vitest run && pnpm biome check src
```

Expected: all clean.

- [ ] **Step 2: Drive the real app**

With `pnpm tauri dev` running (front the dev instance by PID — see the macroni-app-bundle-collision memory: activation by bundle id opens the stale /Applications copy), open the Macros view, select a recording, and verify:

1. `⌈ In` / `⌋ Out` buttons render beside the transport bar; pressing I/O while the video plays sets the range at the playhead (timeline highlight + sidebar chip/inputs update, playback starts looping the range).
2. A lone In loop-previews from the mark to the end; a lone Out from 0 to the mark.
3. The dock chip shows the same range + event count as the sidebar chip.
4. Enter adds a Segment node to the canvas; Escape clears the range.
5. Typing "i"/"o" in the sidebar's Expected text field does NOT mark.
6. Timeline drag-select still works and the chip follows it.

- [ ] **Step 3: Report**

Report each check's outcome. Fix anything broken before claiming done (superpowers:verification-before-completion).
