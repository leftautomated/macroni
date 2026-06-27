import type React from "react";
import { useRef } from "react";
import { type EventRow, getEventDetails, groupEvents, scrollSummary } from "@/lib/event-utils";
import { type InputEvent, InputEventType } from "@/types";

/** A loop region, in video-relative milliseconds. */
export interface LoopRegion {
  a: number;
  b: number;
}

interface StudioTimelineProps {
  events: InputEvent[];
  startMs: number;
  durationMs: number;
  /** Current playhead, video-relative ms. */
  videoMs: number;
  onSeekSeconds: (seconds: number) => void;
  loop: LoopRegion | null;
  onLoopChange: (loop: LoopRegion | null) => void;
}

function fmt(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const COLOR = {
  drag: "#6366f1",
  scroll: "#14b8a6",
  move: "rgba(255,255,255,0.28)",
  click: "#f59e0b",
  key: "#34d399",
};

const KEY_TYPES = new Set<InputEventType>([
  InputEventType.KeyPress,
  InputEventType.KeyRelease,
  InputEventType.KeyCombo,
]);

const isKeyRow = (row: EventRow) =>
  row.kind === "keystroke" || (row.kind === "event" && KEY_TYPES.has(row.event.type));

/**
 * Horizontal, time-aligned view of a recording's events. Groups (drag/scroll)
 * render as spans, discrete events (click/key) as ticks, on a mouse lane and a
 * keyboard lane. A synced playhead scrubs on click; dragging selects a loop
 * region that playback repeats.
 */
export function StudioTimeline({
  events,
  startMs,
  durationMs,
  videoMs,
  onSeekSeconds,
  loop,
  onLoopChange,
}: StudioTimelineProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ downX: number; downMs: number; moved: boolean } | null>(null);

  const dur = Math.max(1, durationMs);
  const rel = (t: number) => Math.min(dur, Math.max(0, t - startMs));
  const pctOf = (ms: number) => (ms / dur) * 100;

  const msAt = (clientX: number) => {
    const el = trackRef.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * dur;
  };

  const onDown = (e: React.PointerEvent) => {
    trackRef.current?.setPointerCapture(e.pointerId);
    drag.current = { downX: e.clientX, downMs: msAt(e.clientX), moved: false };
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (!d.moved && Math.abs(e.clientX - d.downX) > 4) d.moved = true;
    if (d.moved) {
      const cur = msAt(e.clientX);
      onLoopChange({ a: Math.min(d.downMs, cur), b: Math.max(d.downMs, cur) });
    }
  };
  const onUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.moved) {
      onSeekSeconds(Math.min(d.downMs, msAt(e.clientX)) / 1000);
    } else {
      // A plain click clears any loop and seeks there.
      onLoopChange(null);
      onSeekSeconds(d.downMs / 1000);
    }
  };

  const rows = groupEvents(events);
  const mouseRows = rows.filter((r) => !isKeyRow(r));
  const keyRows = rows.filter(isKeyRow);

  const renderRow = (row: EventRow, lane: "mouse" | "keys") => {
    if (row.kind === "event") {
      const start = rel(row.event.timestamp);
      const d = getEventDetails(row.event);
      const color = lane === "keys" ? COLOR.key : COLOR.click;
      return (
        <div
          key={`e${row.index}`}
          className="tl-tick"
          title={`${fmt(start)}  ${d.action}${d.value ? ` ${d.value}` : ""}`}
          style={{ left: `${pctOf(start)}%`, background: color }}
        />
      );
    }
    const start = rel(events[row.startIndex].timestamp);
    if (row.kind === "click") {
      return (
        <div
          key={`c${row.startIndex}`}
          className="tl-tick"
          title={`${fmt(start)}  Click ${row.button}`}
          style={{ left: `${pctOf(start)}%`, background: COLOR.click }}
        />
      );
    }
    if (row.kind === "keystroke") {
      return (
        <div
          key={`k${row.startIndex}`}
          className="tl-tick"
          title={`${fmt(start)}  Key ${row.key}`}
          style={{ left: `${pctOf(start)}%`, background: COLOR.key }}
        />
      );
    }
    const end = rel(events[row.endIndex].timestamp);
    const width = `max(3px, ${pctOf(end - start)}%)`;
    const info =
      row.kind === "drag"
        ? `Drag ${row.button} → (${Math.round(row.x2)}, ${Math.round(row.y2)})`
        : row.kind === "scroll"
          ? `Scroll ${scrollSummary(row.deltaX, row.deltaY)}`
          : "Mouse move";
    const label = row.kind === "drag" ? "Drag" : row.kind === "scroll" ? "Scroll" : "Move";
    return (
      <div
        key={`g${row.startIndex}`}
        className="tl-span"
        title={`${fmt(start)}  ${info}`}
        style={{ left: `${pctOf(start)}%`, width, background: COLOR[row.kind] }}
      >
        <span className="tl-span-label">{label}</span>
      </div>
    );
  };

  const playMs = Math.min(dur, Math.max(0, videoMs));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <style>{`
        .tl-track { position: relative; user-select: none; cursor: pointer; touch-action: none; }
        .tl-lane { position: relative; height: 22px; border-radius: 4px; background: rgba(255,255,255,0.04); }
        .tl-span { position: absolute; top: 3px; height: 16px; border-radius: 3px; opacity: 0.85; overflow: hidden; }
        .tl-span:hover { opacity: 1; }
        .tl-span-label { display: block; font-size: 10px; line-height: 16px; color: #fff; padding: 0 5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; pointer-events: none; }
        .tl-tick { position: absolute; top: 4px; width: 5px; height: 14px; margin-left: -2.5px; border-radius: 2px; opacity: 0.9; }
        .tl-tick:hover { opacity: 1; }
        .tl-clear { border: 1px solid rgba(99,102,241,0.5); background: rgba(99,102,241,0.18); color: #c7d2fe; border-radius: 5px; padding: 1px 7px; font-size: 11px; cursor: pointer; }
        .tl-clear:hover { background: rgba(99,102,241,0.3); }
      `}</style>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          fontSize: 11,
          color: "rgba(255,255,255,0.45)",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        <span>0:00</span>
        {loop ? (
          <button type="button" className="tl-clear" onClick={() => onLoopChange(null)}>
            ⟳ loop {fmt(loop.a)}–{fmt(loop.b)} ✕
          </button>
        ) : (
          <span style={{ color: "rgba(255,255,255,0.3)" }}>drag to loop a range</span>
        )}
        <span>{fmt(dur)}</span>
      </div>

      <div style={{ display: "flex", gap: 12, fontSize: 10, color: "rgba(255,255,255,0.5)" }}>
        {[
          { c: COLOR.drag, l: "Drag" },
          { c: COLOR.scroll, l: "Scroll" },
          { c: COLOR.click, l: "Click" },
          { c: COLOR.key, l: "Key" },
        ].map(({ c, l }) => (
          <span key={l} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            <span style={{ width: 10, height: 8, borderRadius: 2, background: c }} />
            {l}
          </span>
        ))}
      </div>

      <div
        ref={trackRef}
        className="tl-track"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        style={{ display: "flex", flexDirection: "column", gap: 4 }}
      >
        <div className="tl-lane">{mouseRows.map((r) => renderRow(r, "mouse"))}</div>
        <div className="tl-lane">{keyRows.map((r) => renderRow(r, "keys"))}</div>

        {loop && (
          <div
            style={{
              position: "absolute",
              top: 0,
              bottom: 0,
              left: `${pctOf(loop.a)}%`,
              width: `${pctOf(loop.b - loop.a)}%`,
              background: "rgba(99,102,241,0.15)",
              border: "1px solid rgba(99,102,241,0.5)",
              borderRadius: 4,
              pointerEvents: "none",
            }}
          />
        )}
        <div
          style={{
            position: "absolute",
            top: -2,
            bottom: -2,
            left: `${pctOf(playMs)}%`,
            width: 2,
            marginLeft: -1,
            background: "#fff",
            boxShadow: "0 0 4px rgba(0,0,0,0.6)",
            pointerEvents: "none",
          }}
        />
      </div>
    </div>
  );
}
