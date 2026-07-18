import type React from "react";
import { useEffect, useRef, useState } from "react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  type EventRow,
  getEventDetails,
  groupEvents,
  scrollSummary,
  swipeLabel,
} from "@/lib/event-utils";
import type { TrimRange } from "@/lib/recording-trim";
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
  /** Non-destructive kept range. Omit in selection-only timeline contexts. */
  trim?: TrimRange;
  onTrimChange?: (trim: TrimRange) => void;
  onTrimCommit?: (trim: TrimRange) => void;
  /** Perception observations to render as ticks in their own lane, video-relative ms. */
  perceptionTicks?: Array<{ ms: number; label: string }>;
  /** Word used for the dragged range: the player context loops playback
   * ("loop"), the macro authoring dock selects a segment ("selection"). */
  rangeWord?: "loop" | "selection";
}

function fmt(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function fmtPrecise(ms: number): string {
  const safeMs = Math.max(0, Math.floor(ms));
  const seconds = Math.floor(safeMs / 1000);
  const centiseconds = Math.floor((safeMs % 1000) / 10);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}.${String(centiseconds).padStart(2, "0")}`;
}

interface TimelineTooltipProps {
  children: React.ReactNode;
  color: string;
  detail?: string;
  label: string;
  time: string;
  value?: string;
}

function TimelineTooltip({ children, color, detail, label, time, value }: TimelineTooltipProps) {
  const accessibleLabel = [time, label, value, detail].filter(Boolean).join(", ");

  return (
    <Tooltip>
      <TooltipTrigger asChild aria-label={accessibleLabel}>
        {children}
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={8} collisionPadding={12} className="tl-event-tooltip">
        <div className="tl-tooltip-heading">
          <span className="tl-tooltip-swatch" style={{ background: color }} />
          <span className="tl-tooltip-label">{label}</span>
          <time className="tl-tooltip-time">{time}</time>
        </div>
        {value && <div className="tl-tooltip-value">{value}</div>}
        {detail && <div className="tl-tooltip-detail">{detail}</div>}
      </TooltipContent>
    </Tooltip>
  );
}

const COLOR = {
  drag: "#9085e9",
  scroll: "#199e70",
  move: "var(--studio-text-subtle)",
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
  trim,
  onTrimChange,
  onTrimCommit,
  perceptionTicks,
  rangeWord = "loop",
}: StudioTimelineProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ downX: number; downMs: number; moved: boolean } | null>(null);
  const trimDrag = useRef<{ edge: "start" | "end" } | null>(null);
  const trimDraft = useRef<TrimRange | null>(null);
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

  const updateTrimAt = (clientX: number) => {
    const active = trimDraft.current;
    const edge = trimDrag.current?.edge;
    if (!active || !edge || !onTrimChange) return active;
    const minimum = Math.min(100, dur);
    const next =
      edge === "start"
        ? { a: Math.min(msAt(clientX), active.b - minimum), b: active.b }
        : { a: active.a, b: Math.max(msAt(clientX), active.a + minimum) };
    const clamped = {
      a: Math.max(0, Math.min(dur, next.a)),
      b: Math.max(0, Math.min(dur, next.b)),
    };
    trimDraft.current = clamped;
    onTrimChange(clamped);
    return clamped;
  };

  const onTrimDown = (edge: "start" | "end") => (e: React.PointerEvent<HTMLButtonElement>) => {
    if (!trim || !onTrimChange) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    trimDrag.current = { edge };
    trimDraft.current = trim;
  };

  const onTrimMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (!trimDrag.current) return;
    e.preventDefault();
    e.stopPropagation();
    updateTrimAt(e.clientX);
  };

  const onTrimUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (!trimDrag.current) return;
    e.preventDefault();
    e.stopPropagation();
    const finalTrim = updateTrimAt(e.clientX) ?? trimDraft.current;
    trimDrag.current = null;
    trimDraft.current = null;
    if (finalTrim) onTrimCommit?.(finalTrim);
  };

  const onTrimKeyDown = (edge: "start" | "end") => (e: React.KeyboardEvent) => {
    if (!trim || !onTrimChange || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
    e.preventDefault();
    e.stopPropagation();
    const direction = e.key === "ArrowRight" ? 1 : -1;
    const delta = direction * (e.shiftKey ? 1000 : 100);
    const minimum = Math.min(100, dur);
    const next =
      edge === "start"
        ? { a: Math.max(0, Math.min(trim.b - minimum, trim.a + delta)), b: trim.b }
        : { a: trim.a, b: Math.min(dur, Math.max(trim.a + minimum, trim.b + delta)) };
    onTrimChange(next);
    onTrimCommit?.(next);
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
        <TimelineTooltip
          key={`e${row.index}`}
          color={color}
          label={d.action}
          value={d.value}
          detail={d.detail}
          time={fmtPrecise(start)}
        >
          <button
            type="button"
            className="tl-marker tl-tick"
            style={{ left: `${pctOf(start)}%`, background: color }}
          />
        </TimelineTooltip>
      );
    }
    const start = rel(events[row.startIndex].timestamp);
    if (row.kind === "click") {
      return (
        <TimelineTooltip
          key={`c${row.startIndex}`}
          color={COLOR.click}
          label="Click"
          value={`${row.button} button`}
          detail={`(${Math.round(row.x)}, ${Math.round(row.y)})`}
          time={fmtPrecise(start)}
        >
          <button
            type="button"
            className="tl-marker tl-tick"
            style={{ left: `${pctOf(start)}%`, background: COLOR.click }}
          />
        </TimelineTooltip>
      );
    }
    if (row.kind === "keystroke") {
      return (
        <TimelineTooltip
          key={`k${row.startIndex}`}
          color={COLOR.key}
          label="Keystroke"
          value={row.key}
          time={fmtPrecise(start)}
        >
          <button
            type="button"
            className="tl-marker tl-tick"
            style={{ left: `${pctOf(start)}%`, background: COLOR.key }}
          />
        </TimelineTooltip>
      );
    }
    const end = rel(events[row.endIndex].timestamp);
    const width = `max(3px, ${pctOf(end - start)}%)`;
    let label: string;
    let value: string | undefined;
    let detail: string | undefined;
    if (row.kind === "drag") {
      label = "Drag";
      value = `${row.button} button`;
      detail = `(${Math.round(row.x1)}, ${Math.round(row.y1)}) → (${Math.round(row.x2)}, ${Math.round(row.y2)})`;
    } else if (row.kind === "scroll") {
      const sw = swipeLabel(row);
      label = sw ?? "Scroll";
      value = scrollSummary(row.deltaX, row.deltaY);
      detail = `${row.count} input ${row.count === 1 ? "sample" : "samples"}`;
    } else {
      label = "Move";
      value = `(${Math.round(row.x)}, ${Math.round(row.y)})`;
      detail = `${row.count} input ${row.count === 1 ? "sample" : "samples"}`;
    }
    return (
      <TimelineTooltip
        key={`g${row.startIndex}`}
        color={COLOR[row.kind]}
        label={label}
        value={value}
        detail={detail}
        time={`${fmtPrecise(start)}–${fmtPrecise(end)}`}
      >
        <button
          type="button"
          className="tl-marker tl-span"
          style={{ left: `${pctOf(start)}%`, width, background: COLOR[row.kind] }}
        >
          <span className="tl-span-label">{label}</span>
        </button>
      </TimelineTooltip>
    );
  };

  return (
    <TooltipProvider delayDuration={180} skipDelayDuration={80}>
      <div className="studio-timeline" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <style>{`
        .studio-timeline {
          --timeline-cut: rgb(0 0 0 / 58%);
          --timeline-playhead: #fff;
        }
        .light .studio-timeline {
          --timeline-cut: rgb(42 34 22 / 14%);
          --timeline-playhead: var(--studio-text);
        }
        /* Headroom for the ruler labels, which sit just above the tick marks at
           the very top of the track; without it, overflow-y:hidden clips their tops.
           The native horizontal scrollbar is hidden — the .tl-hscroll strip below
           the lanes replaces it, since WKWebView renders the native overlay bar
           however macOS pleases. */
        .tl-scroll { overflow-x: auto; overflow-y: hidden; padding-top: 4px; scrollbar-width: none; }
        .tl-scroll::-webkit-scrollbar { display: none; }
        .tl-hscroll { position: relative; height: 8px; border-radius: 999px; background: var(--studio-surface-soft); cursor: pointer; touch-action: none; transition: opacity 150ms ease; }
        .tl-hthumb { position: absolute; top: 1px; bottom: 1px; border-radius: 999px; background: var(--studio-border-strong); transition: background 120ms ease; }
        .tl-hscroll:hover .tl-hthumb { background: var(--studio-scrollbar-hover); }
        .tl-hscroll:active .tl-hthumb { background: var(--studio-scrollbar-active); }
        .tl-track { position: relative; user-select: none; cursor: pointer; touch-action: none; display: flex; flex-direction: column; gap: 4px; }
        .tl-ruler { position: relative; height: 18px; }
        .tl-tickmark { position: absolute; bottom: 0; width: 1px; background: var(--studio-border-strong); pointer-events: none; }
        .tl-tickmark.major { height: 7px; }
        .tl-tickmark.minor { height: 4px; background: var(--studio-border); }
        .tl-rlabel { position: absolute; bottom: 8px; left: 0; transform: translateX(-50%); font-size: 10px; color: var(--studio-text-muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
        .tl-grid { position: absolute; top: 0; bottom: 0; width: 1px; background: var(--studio-border); pointer-events: none; }
        .tl-lane { position: relative; height: 22px; border-radius: 4px; background: var(--studio-surface-soft); }
        .tl-marker { appearance: none; border: 1px solid transparent; padding: 0; cursor: default; font: inherit; }
        .tl-marker:focus-visible { outline: none; border-color: var(--studio-accent); }
        .tl-span { position: absolute; top: 3px; height: 16px; border-radius: 3px; opacity: 0.85; overflow: hidden; container-type: inline-size; }
        .tl-span:hover, .tl-span:focus-visible { opacity: 1; }
        .tl-span-label { display: none; font-size: 10px; line-height: 16px; color: #fff; padding: 0 5px; white-space: nowrap; pointer-events: none; }
        @container (min-width: 52px) { .tl-span-label { display: block; } }
        .tl-tick { position: absolute; top: 4px; width: 5px; height: 14px; margin-left: -2.5px; border-radius: 2px; opacity: 0.9; }
        .tl-tick:hover, .tl-tick:focus-visible { opacity: 1; transform: scaleX(1.35); }
        .tl-event-tooltip { pointer-events: none; min-width: 168px; max-width: 260px; border-color: var(--studio-border-strong); border-radius: 8px; background: var(--studio-surface); padding: 9px 10px 10px; color: var(--studio-text); box-shadow: 0 10px 28px rgb(0 0 0 / 22%), 0 1px 0 var(--studio-surface-soft) inset; animation: tl-tooltip-in 120ms cubic-bezier(0.22, 1, 0.36, 1); }
        .tl-event-tooltip > svg { fill: var(--studio-surface); }
        .tl-tooltip-heading { display: grid; grid-template-columns: 7px minmax(0, 1fr) auto; align-items: center; gap: 7px; }
        .tl-tooltip-swatch { width: 7px; height: 7px; border-radius: 2px; box-shadow: 0 0 0 1px var(--studio-border) inset; }
        .tl-tooltip-label { overflow: hidden; color: var(--studio-text-muted); font-size: 10px; font-weight: 600; letter-spacing: 0.06em; line-height: 1.2; text-overflow: ellipsis; text-transform: uppercase; white-space: nowrap; }
        .tl-tooltip-time { color: var(--studio-text-subtle); font-size: 10px; font-variant-numeric: tabular-nums; letter-spacing: 0.01em; }
        .tl-tooltip-value { margin-top: 6px; overflow-wrap: anywhere; color: var(--studio-text); font-size: 12px; font-weight: 540; line-height: 1.25; }
        .tl-tooltip-detail { margin-top: 3px; color: var(--studio-text-muted); font-size: 10px; font-variant-numeric: tabular-nums; line-height: 1.3; }
        @keyframes tl-tooltip-in { from { opacity: 0; transform: translateY(2px) scale(0.985); } }
        @media (prefers-reduced-motion: reduce) { .tl-event-tooltip { animation: none; } }
        .tl-clear { border: 1px solid var(--studio-accent-border); background: var(--studio-accent-soft); color: var(--studio-accent); border-radius: 5px; padding: 1px 7px; font-size: 11px; cursor: pointer; }
        .tl-clear:hover { background: color-mix(in oklch, var(--studio-accent) 20%, transparent); }
        .tl-slider { -webkit-appearance: none; appearance: none; width: 90px; height: 6px; border: 1px solid transparent; border-radius: 3px; background: var(--studio-control); cursor: pointer; outline: none; }
        .tl-slider:focus-visible { border-color: var(--studio-accent); }
        .tl-slider::-webkit-slider-thumb { -webkit-appearance: none; appearance:none; width: 11px; height: 11px; border-radius: 50%; background: var(--studio-accent-fill); cursor: pointer; }
        .tl-slider::-webkit-slider-thumb:hover { background: var(--studio-accent-fill-hover); }
        .tl-cut { position: absolute; top: 0; bottom: 0; background: var(--timeline-cut); pointer-events: none; z-index: 5; }
        .tl-trim-line { position: absolute; top: 0; bottom: 0; width: 2px; margin-left: -1px; background: var(--studio-accent-fill); box-shadow: 0 0 0 1px rgb(0 0 0 / 25%); pointer-events: none; z-index: 7; }
        .tl-trim-handle { position: absolute; top: 50%; z-index: 8; width: 16px; height: 36px; padding: 0; transform: translate(-50%, -50%); border: 1px solid var(--studio-accent-border); border-radius: 5px; background: var(--studio-accent-fill); color: #201b0f; cursor: ew-resize; touch-action: none; box-shadow: 0 2px 8px rgb(0 0 0 / 28%); }
        .tl-trim-handle::after { content: ""; position: absolute; top: 9px; bottom: 9px; left: 6px; width: 2px; border-left: 1px solid rgba(32,27,15,0.7); border-right: 1px solid rgba(32,27,15,0.7); }
        .tl-trim-handle:hover, .tl-trim-handle:focus-visible { background: var(--studio-accent-fill-hover); border-color: var(--studio-accent); outline: none; }
        .tl-trim-status { display: inline-flex; align-items: center; gap: 7px; color: var(--studio-accent); }
        .tl-trim-reset { border: 1px solid transparent; border-radius: 4px; padding: 1px 2px; margin: -2px -3px; background: transparent; color: var(--studio-text-subtle); font: inherit; cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }
        .tl-trim-reset:hover { color: var(--studio-text); }
      `}</style>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            fontSize: 11,
            color: "var(--studio-text-subtle)",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <input
              type="range"
              className="tl-slider"
              style={{
                background: `linear-gradient(to right, var(--studio-accent-fill) ${zoomPos * 100}%, var(--studio-control) ${zoomPos * 100}%)`,
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
          {trim && (trim.a > 0 || trim.b < dur) ? (
            <span className="tl-trim-status">
              Kept {fmtPrecise(trim.a)}–{fmtPrecise(trim.b)}
              <button
                type="button"
                className="tl-trim-reset"
                onClick={() => {
                  const full = { a: 0, b: dur };
                  onTrimChange?.(full);
                  onTrimCommit?.(full);
                }}
              >
                Reset trim
              </button>
            </span>
          ) : loop ? (
            <button type="button" className="tl-clear" onClick={() => onLoopChange(null)}>
              {rangeWord === "selection" ? "selection" : "⟳ loop"} {fmt(loop.a)}–{fmt(loop.b)} ✕
            </button>
          ) : (
            <span style={{ color: "var(--studio-text-subtle)" }}>
              {trim
                ? "drag gold handles to cut or extend"
                : `drag to ${rangeWord === "selection" ? "select" : "loop"} a range`}
            </span>
          )}
          <span>{fmt(dur)}</span>
        </div>

        <div style={{ display: "flex", gap: 12, fontSize: 10, color: "var(--studio-text-muted)" }}>
          {[
            { c: COLOR.drag, l: "Drag" },
            { c: COLOR.scroll, l: "Scroll" },
            { c: COLOR.click, l: "Click" },
            { c: COLOR.key, l: "Key" },
            { c: COLOR.space, l: "Space" },
            ...(perceptionTicks && perceptionTicks.length > 0
              ? [{ c: "var(--studio-accent)", l: "Text" }]
              : []),
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
                  <TimelineTooltip
                    key={`p${i}`}
                    color="var(--studio-accent)"
                    label="Text snapshot"
                    value={t.label}
                    time={fmtPrecise(t.ms)}
                  >
                    <button
                      type="button"
                      className="tl-marker tl-tick"
                      style={{
                        left: `${pctOf(t.ms)}%`,
                        background: "var(--studio-accent)",
                        cursor: "pointer",
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        onSeekSeconds(t.ms / 1000);
                      }}
                      onPointerDown={(e) => e.stopPropagation()}
                    />
                  </TimelineTooltip>
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
                  background: "var(--studio-accent-soft)",
                  border: "1px solid var(--studio-accent-border)",
                  borderRadius: 4,
                  pointerEvents: "none",
                }}
              />
            )}
            {trim && (
              <>
                <div className="tl-cut" style={{ left: 0, width: `${pctOf(trim.a)}%` }} />
                <div className="tl-cut" style={{ left: `${pctOf(trim.b)}%`, right: 0 }} />
                <div className="tl-trim-line" style={{ left: `${pctOf(trim.a)}%` }} />
                <div className="tl-trim-line" style={{ left: `${pctOf(trim.b)}%` }} />
                <button
                  type="button"
                  className="tl-trim-handle"
                  style={{
                    left: `${pctOf(trim.a)}%`,
                    transform: `translate(${trim.a <= 0 ? "0" : "-50%"}, -50%)`,
                  }}
                  aria-label={`Trim start at ${fmtPrecise(trim.a)}`}
                  title="Drag to set the start"
                  onPointerDown={onTrimDown("start")}
                  onPointerMove={onTrimMove}
                  onPointerUp={onTrimUp}
                  onPointerCancel={onTrimUp}
                  onKeyDown={onTrimKeyDown("start")}
                />
                <button
                  type="button"
                  className="tl-trim-handle"
                  style={{
                    left: `${pctOf(trim.b)}%`,
                    transform: `translate(${trim.b >= dur ? "-100%" : "-50%"}, -50%)`,
                  }}
                  aria-label={`Trim end at ${fmtPrecise(trim.b)}`}
                  title="Drag to set the end"
                  onPointerDown={onTrimDown("end")}
                  onPointerMove={onTrimMove}
                  onPointerUp={onTrimUp}
                  onPointerCancel={onTrimUp}
                  onKeyDown={onTrimKeyDown("end")}
                />
              </>
            )}
            <div
              style={{
                position: "absolute",
                top: 0,
                bottom: 0,
                left: `${pctOf(playMs)}%`,
                width: 2,
                marginLeft: -1,
                background: "var(--timeline-playhead)",
                boxShadow: "0 0 4px rgb(0 0 0 / 38%)",
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
          {hThumb && (
            <div className="tl-hthumb" style={{ left: hThumb.left, width: hThumb.width }} />
          )}
        </div>
      </div>
    </TooltipProvider>
  );
}
