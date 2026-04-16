import { useRef, useCallback } from "react";
import { InputEvent, InputEventType } from "@/types";

interface Props {
  events: InputEvent[];
  startMs: number;
  durationMs: number;
  activeIndex: number;
  onSeek: (absoluteMs: number) => void;
}

const colorFor = (type: InputEventType): string => {
  switch (type) {
    case InputEventType.KeyPress:
    case InputEventType.KeyRelease:
    case InputEventType.KeyCombo:
      return "bg-blue-500";
    case InputEventType.ButtonPress:
    case InputEventType.ButtonRelease:
      return "bg-amber-500";
    default:
      return "bg-muted-foreground";
  }
};

export function EventTimeline({ events, startMs, durationMs, activeIndex, onSeek }: Props) {
  const trackRef = useRef<HTMLDivElement>(null);

  const handleTrackClick = useCallback(
    (e: React.MouseEvent) => {
      if (!trackRef.current || durationMs <= 0) return;
      const rect = trackRef.current.getBoundingClientRect();
      const ratio = (e.clientX - rect.left) / rect.width;
      onSeek(startMs + ratio * durationMs);
    },
    [durationMs, startMs, onSeek],
  );

  const renderable = events
    .map((e, i) => ({ event: e, index: i }))
    .filter(({ event }) => event.type !== InputEventType.MouseMove);

  return (
    <div className="relative w-full h-6" onClick={handleTrackClick}>
      <div ref={trackRef} className="absolute inset-0 bg-muted/30 rounded" />
      {renderable.map(({ event, index }, i) => {
        const pct = durationMs > 0 ? ((event.timestamp - startMs) / durationMs) * 100 : 0;
        const active = index === activeIndex;
        return (
          <div
            key={i}
            data-testid={`event-marker-${i}`}
            title={event.type}
            style={{ left: `${pct}%` }}
            className={`absolute top-0 bottom-0 w-0.5 ${colorFor(event.type)} ${active ? "ring-2 ring-primary" : ""}`}
            onClick={(e) => {
              e.stopPropagation();
              onSeek(event.timestamp);
            }}
          />
        );
      })}
    </div>
  );
}
