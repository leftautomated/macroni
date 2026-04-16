import { useEffect, useRef } from "react";
import { InputEvent, InputEventType } from "@/types";

interface Props {
  events: InputEvent[];
  activeIndex: number;
  onClickEvent: (index: number) => void;
  onUserScroll: () => void;
  autoScrollEnabled: boolean;
}

const describe = (event: InputEvent): string => {
  switch (event.type) {
    case InputEventType.KeyPress:
      return `KeyPress ${event.key}`;
    case InputEventType.KeyRelease:
      return `KeyRelease ${event.key}`;
    case InputEventType.KeyCombo:
      return `${event.modifiers.join("+")}+${event.char}`;
    case InputEventType.ButtonPress:
      return `ButtonPress ${event.button} (${event.x.toFixed(0)}, ${event.y.toFixed(0)})`;
    case InputEventType.ButtonRelease:
      return `ButtonRelease ${event.button}`;
    case InputEventType.MouseMove:
      return `MouseMove (${event.x.toFixed(0)}, ${event.y.toFixed(0)})`;
  }
};

export function SyncedEventList({
  events,
  activeIndex,
  onClickEvent,
  onUserScroll,
  autoScrollEnabled,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    if (!autoScrollEnabled) return;
    const el = itemRefs.current[activeIndex];
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [activeIndex, autoScrollEnabled]);

  return (
    <div
      ref={containerRef}
      className="h-full overflow-y-auto border rounded-lg bg-muted/20 p-2 font-mono text-xs"
      onScroll={onUserScroll}
      onWheel={onUserScroll}
    >
      {events.map((e, i) => (
        <div
          key={i}
          ref={(el) => {
            itemRefs.current[i] = el;
          }}
          onClick={() => onClickEvent(i)}
          className={`px-2 py-1 rounded cursor-pointer ${
            i === activeIndex ? "bg-primary/20" : "hover:bg-muted/40"
          }`}
        >
          <span className="text-muted-foreground mr-2">{e.timestamp}</span>
          {describe(e)}
        </div>
      ))}
    </div>
  );
}
