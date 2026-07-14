import type React from "react";
import { useEffect, useRef, useState } from "react";
import {
  type EventRow,
  getEventDetails,
  groupEvents,
  scrollSummary,
  swipeLabel,
} from "@/lib/event-utils";
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
  /** Perception observations to render as ticks in their own lane, video-relative ms. */
  perceptionTicks?: Array<{ ms: number; label: string }>;
}

function fmt(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const COLOR = {
  drag: "#9085e9",
  scroll: "#199e70",
  move: "rgba(255,255,255,0.28)",
  click: "#c98500",
  key: "#3987e5",
  space: "#d55181",
};

const KEY_TYPES = new Set<InputEventType>([
  InputEventType.KeyPress,
  InputEventType.KeyRelease,
  InputEventType.KeyCombo,
  InputEventType.SpaceSwitch,
]);

const isKeyRow = (row: EventRow) =>
  row.kind === "keystroke" || (row.kind === "event" && KEY_TYPES.has(row.event.type));

// How many seconds fill the viewport by default — tight enough to read events
// at the seconds level, while longer recordings scroll horizontally.
const DEFAULT_SECONDS_VISIBLE = 30;
const MIN_SECONDS_VISIBLE = 2;

/** A "nice" labeled-tick interval (seconds), aiming for ~6 labels per window. */
function majorIntervalSec(visibleSec: number): number {
  const target = visibleSec / 6;
  const candidates = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  return candidates.find((c) => c >= target) ?? 600;
}

/**
 * Horizontal, time-aligned view of a recording's events. Groups (drag/scroll)
 * render as spans, discrete events (click/key) as ticks, on a mouse lane and a
 * keyboard lane, under a labeled time ruler. The viewport shows a fixed window
 * (default 30s) and scrolls horizontally — zoomable — so events are readable at
 * the seconds level; the playhead is kept in view as the video plays. Clicking
 * seeks; dragging selects a loop region that playback repeats.
 */
export function StudioTimeline({
  events,
  startMs,
  durationMs,
  videoMs,
  onSeekSeconds,
  loop,
  onLoopChange,
  perceptionTicks,
}: StudioTimelineProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ downX: number; downMs: number; moved: boolean } | null>(null);
  // Whether the view should keep the playhead in sight. The user scrolling
  // turns it off (so playback doesn't yank the view back); clicking/seeking or
  // loading another clip turns it back on.
  const follow = useRef(true);
  const [secondsVisible, setSecondsVisible] = useState(DEFAULT_SECONDS_VISIBLE);
  // Custom horizontal scrollbar (the native one is hidden): thumb geometry in
  // px within the strip, or null while the track fits the viewport.
  const hTrackRef = useRef<HTMLDivElement>(null);
  const hDrag = useRef<{ startX: number; startScrollLeft: number } | null>(null);
  const [hThumb, setHThumb] = useState<{ left: number; width: number } | null>(null);

  const dur = Math.max(1, durationMs);
  const durSec = dur / 1000;
  const maxVisible = Math.max(DEFAULT_SECONDS_VISIBLE, durSec);
  const rel = (t: number) => Math.min(dur, Math.max(0, t - startMs));
  const pctOf = (ms: number) => (ms / dur) * 100;

  // Track width as a % of the scroll viewport: the full duration scaled so the
  // visible window spans 100%. ≥100% so short recordings still fill the width.
  const trackWidthPct = Math.max(100, (durSec / secondsVisible) * 100);

  const playMs = Math.min(dur, Math.max(0, videoMs));

  // Keep the playhead in view as it moves (and after a zoom): recenter when it
  // drifts out of the comfortable middle band.
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || !follow.current) return;
    const full = scroller.scrollWidth;
    const view = scroller.clientWidth;
    if (full <= view + 1) return;
    const x = (playMs / dur) * full;
    const margin = view * 0.15;
    if (x < scroller.scrollLeft + margin || x > scroller.scrollLeft + view - margin) {
      scroller.scrollLeft = Math.max(0, Math.min(full - view, x - view / 2));
    }
  }, [playMs, dur, secondsVisible]);

  // Re-engage follow when a different recording loads.
  useEffect(() => {
    follow.current = true;
  }, [durationMs, startMs]);

  // Mirror the scroller's geometry into the custom scrollbar thumb. The strip
  // spans the same width as the viewport, so px map 1:1.
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const measure = () => {
      const view = scroller.clientWidth;
      const full = scroller.scrollWidth;
      if (full <= view + 1) {
        setHThumb(null);
        return;
      }
      const width = Math.max(30, (view / full) * view);
      const left = (scroller.scrollLeft / (full - view)) * (view - width);
      setHThumb({ left, width });
    };
    measure();
    scroller.addEventListener("scroll", measure, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(scroller);
    return () => {
      scroller.removeEventListener("scroll", measure);
      ro.disconnect();
    };
  }, [trackWidthPct]);

  const hDown = (e: React.PointerEvent) => {
    const scroller = scrollRef.current;
    const track = hTrackRef.current;
    if (!scroller || !track || !hThumb) return;
    // The user is navigating — stop pulling the view back to the playhead.
    follow.current = false;
    track.setPointerCapture(e.pointerId);
    let scrollLeft = scroller.scrollLeft;
    const rect = track.getBoundingClientRect();
    const x = e.clientX - rect.left;
    if (x < hThumb.left || x > hThumb.left + hThumb.width) {
      // Pressing the track outside the thumb centers the thumb on the pointer
      // (macOS "jump to spot"), then the drag continues from there.
      const range = rect.width - hThumb.width;
      const ratio = Math.min(1, Math.max(0, (x - hThumb.width / 2) / range));
      scrollLeft = ratio * (scroller.scrollWidth - scroller.clientWidth);
      scroller.scrollLeft = scrollLeft;
    }
    hDrag.current = { startX: e.clientX, startScrollLeft: scrollLeft };
  };
  const hMove = (e: React.PointerEvent) => {
    const d = hDrag.current;
    const scroller = scrollRef.current;
    const track = hTrackRef.current;
    if (!d || !scroller || !track || !hThumb) return;
    const range = track.getBoundingClientRect().width - hThumb.width;
    if (range <= 0) return;
    const scrollable = scroller.scrollWidth - scroller.clientWidth;
    scroller.scrollLeft = d.startScrollLeft + ((e.clientX - d.startX) * scrollable) / range;
  };
  const hUp = () => {
    hDrag.current = null;
  };

  // Zoom slider maps log-linearly: left = whole recording, right = most zoomed-in.
  const logMin = Math.log(MIN_SECONDS_VISIBLE);
  const logMax = Math.log(maxVisible);
  const zoomPos = logMax > logMin ? (logMax - Math.log(secondsVisible)) / (logMax - logMin) : 1;
  const setZoomFromPos = (pos: number) =>
    setSecondsVisible(Math.exp(logMax - pos * (logMax - logMin)));

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
    // Interacting with the track re-engages playhead-follow.
    follow.current = true;
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

  // Labeled (major) + unlabeled (minor) ruler ticks across the recording.
  const major = majorIntervalSec(secondsVisible);
  const minor = major / 2;
  const majorSecs: number[] = [];
  const minorSecs: number[] = [];
  for (let i = 1; i * minor < durSec; i++) {
    const t = i * minor;
    if (i % 2 === 0) majorSecs.push(t);
    else minorSecs.push(t);
  }

  const renderRow = (row: EventRow, lane: "mouse" | "keys") => {
    if (row.kind === "event") {
      const start = rel(row.event.timestamp);
      const d = getEventDetails(row.event);
      const color =
        row.event.type === InputEventType.SpaceSwitch
          ? COLOR.space
          : lane === "keys"
            ? COLOR.key
            : COLOR.click;
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
    let info: string;
    let label: string;
    if (row.kind === "drag") {
      info = `Drag ${row.button} → (${Math.round(row.x2)}, ${Math.round(row.y2)})`;
      label = "Drag";
    } else if (row.kind === "scroll") {
      const sw = swipeLabel(row);
      label = sw ?? "Scroll";
      info = sw
        ? `${sw} (${scrollSummary(row.deltaX, row.deltaY)})`
        : `Scroll ${scrollSummary(row.deltaX, row.deltaY)}`;
    } else {
      info = "Mouse move";
      label = "Move";
    }
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

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <style>{`
        /* Headroom for the ruler labels, which sit just above the tick marks at
           the very top of the track; without it, overflow-y:hidden clips their tops.
           The native horizontal scrollbar is hidden — the .tl-hscroll strip below
           the lanes replaces it, since WKWebView renders the native overlay bar
           however macOS pleases. */
        .tl-scroll { overflow-x: auto; overflow-y: hidden; padding-top: 4px; scrollbar-width: none; }
        .tl-scroll::-webkit-scrollbar { display: none; }
        .tl-hscroll { position: relative; height: 8px; border-radius: 999px; background: rgba(255,255,255,0.05); cursor: pointer; touch-action: none; transition: opacity 150ms ease; }
        .tl-hthumb { position: absolute; top: 1px; bottom: 1px; border-radius: 999px; background: rgba(255,255,255,0.2); transition: background 120ms ease; }
        .tl-hscroll:hover .tl-hthumb { background: rgba(255,255,255,0.35); }
        .tl-hscroll:active .tl-hthumb { background: rgba(255,255,255,0.5); }
        .tl-track { position: relative; user-select: none; cursor: pointer; touch-action: none; display: flex; flex-direction: column; gap: 4px; }
        .tl-ruler { position: relative; height: 18px; }
        .tl-tickmark { position: absolute; bottom: 0; width: 1px; background: rgba(255,255,255,0.22); pointer-events: none; }
        .tl-tickmark.major { height: 7px; }
        .tl-tickmark.minor { height: 4px; background: rgba(255,255,255,0.12); }
        .tl-rlabel { position: absolute; bottom: 8px; left: 0; transform: translateX(-50%); font-size: 10px; color: rgba(255,255,255,0.5); white-space: nowrap; font-variant-numeric: tabular-nums; }
        .tl-grid { position: absolute; top: 0; bottom: 0; width: 1px; background: rgba(255,255,255,0.05); pointer-events: none; }
        .tl-lane { position: relative; height: 22px; border-radius: 4px; background: rgba(255,255,255,0.04); }
        .tl-span { position: absolute; top: 3px; height: 16px; border-radius: 3px; opacity: 0.85; overflow: hidden; }
        .tl-span:hover { opacity: 1; }
        .tl-span-label { display: block; font-size: 10px; line-height: 16px; color: #fff; padding: 0 5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; pointer-events: none; }
        .tl-tick { position: absolute; top: 4px; width: 5px; height: 14px; margin-left: -2.5px; border-radius: 2px; opacity: 0.9; }
        .tl-tick:hover { opacity: 1; }
        .tl-clear { border: 1px solid rgba(240,205,120,0.5); background: rgba(240,205,120,0.16); color: #f4dda4; border-radius: 5px; padding: 1px 7px; font-size: 11px; cursor: pointer; }
        .tl-clear:hover { background: rgba(240,205,120,0.26); }
        .tl-slider { -webkit-appearance: none; appearance: none; width: 90px; height: 4px; border-radius: 2px; background: rgba(255,255,255,0.18); cursor: pointer; outline: none; }
        .tl-slider::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 11px; height: 11px; border-radius: 50%; background: #f0cd78; cursor: pointer; }
        .tl-slider::-webkit-slider-thumb:hover { background: #f4dda4; }
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
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <input
            type="range"
            className="tl-slider"
            style={{
              background: `linear-gradient(to right, #f0cd78 ${zoomPos * 100}%, rgba(255,255,255,0.18) ${zoomPos * 100}%)`,
            }}
            min={0}
            max={1}
            step={0.001}
            value={zoomPos}
            onChange={(e) => setZoomFromPos(Number(e.target.value))}
            title="Zoom"
            aria-label="Zoom"
          />
          <span style={{ minWidth: 26, textAlign: "right" }}>{Math.round(secondsVisible)}s</span>
        </span>
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
          { c: COLOR.space, l: "Space" },
          ...(perceptionTicks && perceptionTicks.length > 0 ? [{ c: "#f4dda4", l: "Text" }] : []),
        ].map(({ c, l }) => (
          <span key={l} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            <span style={{ width: 10, height: 8, borderRadius: 2, background: c }} />
            {l}
          </span>
        ))}
      </div>

      <div
        className="tl-scroll"
        ref={scrollRef}
        onWheel={() => {
          // The user is navigating the timeline — stop pulling the view back to
          // the playhead until they click/seek again.
          follow.current = false;
        }}
      >
        <div
          ref={trackRef}
          className="tl-track"
          style={{ width: `${trackWidthPct}%` }}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
        >
          {majorSecs.map((t) => (
            <div key={`grid${t}`} className="tl-grid" style={{ left: `${pctOf(t * 1000)}%` }} />
          ))}

          <div className="tl-ruler">
            {minorSecs.map((t) => (
              <div
                key={`min${t}`}
                className="tl-tickmark minor"
                style={{ left: `${pctOf(t * 1000)}%` }}
              />
            ))}
            {majorSecs.map((t) => (
              <div
                key={`maj${t}`}
                className="tl-tickmark major"
                style={{ left: `${pctOf(t * 1000)}%` }}
              >
                <span className="tl-rlabel">{fmt(t * 1000)}</span>
              </div>
            ))}
          </div>

          <div className="tl-lane">{mouseRows.map((r) => renderRow(r, "mouse"))}</div>
          <div className="tl-lane">{keyRows.map((r) => renderRow(r, "keys"))}</div>

          {perceptionTicks && perceptionTicks.length > 0 && (
            <div className="tl-lane">
              {perceptionTicks.map((t, i) => (
                <div
                  key={`p${i}`}
                  className="tl-tick"
                  title={t.label}
                  style={{ left: `${pctOf(t.ms)}%`, background: "#f4dda4", cursor: "pointer" }}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSeekSeconds(t.ms / 1000);
                  }}
                  onPointerDown={(e) => e.stopPropagation()}
                />
              ))}
            </div>
          )}

          {loop && (
            <div
              style={{
                position: "absolute",
                top: 0,
                bottom: 0,
                left: `${pctOf(loop.a)}%`,
                width: `${pctOf(loop.b - loop.a)}%`,
                background: "rgba(240,205,120,0.15)",
                border: "1px solid rgba(240,205,120,0.5)",
                borderRadius: 4,
                pointerEvents: "none",
              }}
            />
          )}
          <div
            style={{
              position: "absolute",
              top: 0,
              bottom: 0,
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

      {/* Always mounted at fixed height so appearing/disappearing (zooming
          across the fits-the-viewport threshold) causes no layout shift. */}
      <div
        ref={hTrackRef}
        className="tl-hscroll"
        style={hThumb ? undefined : { opacity: 0, pointerEvents: "none" }}
        onPointerDown={hDown}
        onPointerMove={hMove}
        onPointerUp={hUp}
      >
        {hThumb && <div className="tl-hthumb" style={{ left: hThumb.left, width: hThumb.width }} />}
      </div>
    </div>
  );
}
