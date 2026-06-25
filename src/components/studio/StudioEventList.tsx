import { useEffect, useMemo, useRef, useState } from "react";
import { Keyboard, Mouse, MousePointer } from "lucide-react";
import { getEventDetails, groupEvents, scrollSummary } from "@/lib/event-utils";
import { type InputEvent, InputEventType } from "@/types";

interface StudioEventListProps {
  events: InputEvent[];
  startMs: number;
  activeIndex: number;
  onSeek: (index: number) => void;
  onUserScroll: () => void;
  autoScrollEnabled: boolean;
}

// Time relative to the recording start, as m:ss.cc (centiseconds).
function relTime(ms: number): string {
  const total = Math.max(0, ms);
  const m = Math.floor(total / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const cs = Math.floor((total % 1000) / 10);
  return `${m}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

const MOUSE_TYPES = new Set<InputEventType>([
  InputEventType.ButtonPress,
  InputEventType.ButtonRelease,
  InputEventType.MouseMove,
]);

/**
 * Timestamped, scrollable list of a recording's input events, synced to video
 * playback: the active event is highlighted and clicking a row seeks the video.
 * High-frequency runs (scroll, mouse-move) and click pairs are collapsed into
 * one summary row to stay readable; clicking a summary row expands it to reveal
 * every underlying event. The backend keeps every event regardless.
 */
export function StudioEventList({
  events,
  startMs,
  activeIndex,
  onSeek,
  onUserScroll,
  autoScrollEnabled,
}: StudioEventListProps) {
  const rows = useMemo(() => groupEvents(events), [events]);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const containerRef = useRef<HTMLDivElement>(null);

  // Follow playback: scroll the active row (or active child) into view. Driven
  // off a data-attribute so we don't juggle refs across rows and children.
  useEffect(() => {
    if (!autoScrollEnabled) return;
    containerRef.current
      ?.querySelector("[data-active]")
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [activeIndex, autoScrollEnabled]);

  const toggle = (key: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const renderEventRow = (event: InputEvent, index: number, indent: boolean) => {
    const d = getEventDetails(event);
    const Icon = MOUSE_TYPES.has(event.type) ? MousePointer : Keyboard;
    const active = index === activeIndex;
    return (
      <button
        type="button"
        key={`e${index}`}
        data-active={active ? "" : undefined}
        className={`evt-row${active ? " active" : ""}`}
        style={indent ? { paddingLeft: 30 } : undefined}
        onClick={() => onSeek(index)}
      >
        {!indent && <span className="evt-chevron" />}
        <span className="evt-time">{relTime(event.timestamp - startMs)}</span>
        <span className="evt-icon">
          <Icon size={12} />
        </span>
        <span className="evt-desc">
          {d.action}
          {d.value ? ` ${d.value}` : ""}
        </span>
        {d.detail && <span className="evt-detail">{d.detail}</span>}
      </button>
    );
  };

  return (
    <div
      style={{
        width: 300,
        flexShrink: 0,
        height: "100%",
        display: "flex",
        flexDirection: "column",
        borderLeft: "1px solid rgba(255,255,255,0.08)",
        background: "rgba(20,20,28,0.96)",
      }}
    >
      <style>{`
        .evt-row { display:flex; align-items:center; gap:8px; width:100%; text-align:left; border:none; background:transparent; color:#e5e7eb; border-radius:6px; padding:6px 10px; cursor:pointer; font-size:12px; transition: background 90ms ease; }
        .evt-row:hover { background: rgba(255,255,255,0.05); }
        .evt-row.active { background: rgba(99,102,241,0.22); }
        .evt-chevron { width:12px; flex-shrink:0; color: rgba(255,255,255,0.4); font-size:10px; display:inline-flex; align-items:center; }
        .evt-time { font-variant-numeric: tabular-nums; color: rgba(255,255,255,0.45); flex-shrink:0; width:54px; }
        .evt-icon { color: rgba(255,255,255,0.55); flex-shrink:0; display:inline-flex; }
        .evt-desc { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .evt-detail { color: rgba(255,255,255,0.4); margin-left:auto; flex-shrink:0; padding-left:8px; }
        /* Themed scrollbars for the whole studio window (universal selector,
           like the main app's index.css — WKWebView honors ::-webkit-scrollbar
           this way). Lives in this component's <style> because it is reliably
           mounted whenever there's anything to scroll (a recording auto-selects
           on open), so it survives HMR. */
        * { scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.18) transparent; }
        *::-webkit-scrollbar { width: 8px; height: 8px; }
        *::-webkit-scrollbar-track { background: transparent; }
        *::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.18); border-radius: 4px; border: 2px solid transparent; background-clip: padding-box; }
        *::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.32); background-clip: padding-box; }
      `}</style>
      <div style={{ padding: "14px 14px 10px", fontSize: 13, fontWeight: 600, letterSpacing: 0.3 }}>
        EVENTS{" "}
        <span style={{ color: "rgba(255,255,255,0.4)", fontWeight: 400 }}>· {events.length}</span>
      </div>
      <div
        ref={containerRef}
        style={{ flex: 1, overflowY: "auto", padding: "0 6px 8px" }}
        onScroll={onUserScroll}
        onWheel={onUserScroll}
      >
        {events.length === 0 ? (
          <div style={{ padding: 14, fontSize: 12, color: "rgba(255,255,255,0.4)" }}>
            No events recorded for this clip.
          </div>
        ) : (
          rows.map((row) => {
            if (row.kind === "event") return renderEventRow(row.event, row.index, false);

            const isOpen = expanded.has(row.startIndex);
            const headerActive =
              !isOpen && activeIndex >= row.startIndex && activeIndex <= row.endIndex;
            const childCount = row.endIndex - row.startIndex + 1;
            const view =
              row.kind === "scroll"
                ? {
                    icon: <Mouse size={12} />,
                    label: `Scroll ${scrollSummary(row.deltaX, row.deltaY)}`,
                    detail: `×${row.count}`,
                  }
                : row.kind === "move"
                  ? {
                      icon: <MousePointer size={12} />,
                      label: `Mouse Move (${Math.round(row.x)}, ${Math.round(row.y)})`,
                      detail: `×${row.count}`,
                    }
                  : {
                      icon: <MousePointer size={12} />,
                      label: `Click ${row.button}`,
                      detail: `(${Math.round(row.x)}, ${Math.round(row.y)})`,
                    };

            return (
              <div key={`g${row.startIndex}`}>
                <button
                  type="button"
                  data-active={headerActive ? "" : undefined}
                  className={`evt-row${headerActive ? " active" : ""}`}
                  onClick={() => toggle(row.startIndex)}
                  title={isOpen ? "Collapse" : `Expand ${childCount} events`}
                >
                  <span className="evt-chevron">{isOpen ? "▾" : "▸"}</span>
                  <span className="evt-time">{relTime(row.timestamp - startMs)}</span>
                  <span className="evt-icon">{view.icon}</span>
                  <span className="evt-desc">{view.label}</span>
                  {view.detail && <span className="evt-detail">{view.detail}</span>}
                </button>
                {isOpen &&
                  Array.from({ length: childCount }, (_, i) =>
                    renderEventRow(events[row.startIndex + i], row.startIndex + i, true),
                  )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
