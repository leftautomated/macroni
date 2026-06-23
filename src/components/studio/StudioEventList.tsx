import { useEffect, useRef } from "react";
import { Keyboard, MousePointer } from "lucide-react";
import { type InputEvent, InputEventType } from "@/types";
import { getEventDetails } from "@/lib/event-utils";

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
 * Auto-scrolls to follow playback unless the user has scrolled recently.
 */
export function StudioEventList({
  events,
  startMs,
  activeIndex,
  onSeek,
  onUserScroll,
  autoScrollEnabled,
}: StudioEventListProps) {
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    if (!autoScrollEnabled) return;
    itemRefs.current[activeIndex]?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [activeIndex, autoScrollEnabled]);

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
        .evt-time { font-variant-numeric: tabular-nums; color: rgba(255,255,255,0.45); flex-shrink:0; width:54px; }
        .evt-icon { color: rgba(255,255,255,0.55); flex-shrink:0; display:inline-flex; }
        .evt-desc { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .evt-detail { color: rgba(255,255,255,0.4); margin-left:auto; flex-shrink:0; padding-left:8px; }
      `}</style>
      <div style={{ padding: "14px 14px 10px", fontSize: 13, fontWeight: 600, letterSpacing: 0.3 }}>
        EVENTS{" "}
        <span style={{ color: "rgba(255,255,255,0.4)", fontWeight: 400 }}>· {events.length}</span>
      </div>
      <div
        style={{ flex: 1, overflowY: "auto", padding: "0 6px 8px" }}
        onScroll={onUserScroll}
        onWheel={onUserScroll}
      >
        {events.length === 0 ? (
          <div style={{ padding: 14, fontSize: 12, color: "rgba(255,255,255,0.4)" }}>
            No events recorded for this clip.
          </div>
        ) : (
          events.map((e, i) => {
            const d = getEventDetails(e);
            const Icon = MOUSE_TYPES.has(e.type) ? MousePointer : Keyboard;
            return (
              <button
                type="button"
                key={i}
                ref={(el) => {
                  itemRefs.current[i] = el;
                }}
                className={`evt-row${i === activeIndex ? " active" : ""}`}
                onClick={() => onSeek(i)}
              >
                <span className="evt-time">{relTime(e.timestamp - startMs)}</span>
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
          })
        )}
      </div>
    </div>
  );
}
