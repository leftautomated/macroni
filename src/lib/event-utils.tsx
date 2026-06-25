import { Keyboard, Mouse, MousePointer } from "lucide-react";
import { type InputEvent, InputEventType } from "@/types";

/**
 * Arrow(s) + magnitude for a scroll delta, e.g. "↓ 240" or "↑ 60  → 12".
 * Sign convention is descriptive: positive deltaY = down, positive deltaX =
 * right. Used for both single scrolls and summed scroll groups.
 */
export function scrollSummary(deltaX: number, deltaY: number): string {
  const parts: string[] = [];
  if (deltaY !== 0) parts.push(`${deltaY > 0 ? "↓" : "↑"} ${Math.abs(deltaY)}`);
  if (deltaX !== 0) parts.push(`${deltaX > 0 ? "→" : "←"} ${Math.abs(deltaX)}`);
  return parts.length > 0 ? parts.join("  ") : "—";
}

export interface EventDetails {
  icon: React.ReactNode;
  action: string;
  value: string;
  detail: string;
}

export function getEventDetails(event: InputEvent): EventDetails {
  switch (event.type) {
    case InputEventType.KeyPress:
      return {
        icon: <Keyboard className="h-3 w-3" />,
        action: "Key Press",
        value: event.key,
        detail: "",
      };
    case InputEventType.KeyRelease:
      return {
        icon: <Keyboard className="h-3 w-3" />,
        action: "Key Release",
        value: event.key,
        detail: "",
      };
    case InputEventType.KeyCombo:
      return {
        icon: <Keyboard className="h-3 w-3" />,
        action: "Key Combo",
        value: event.char,
        detail: `${event.modifiers.join(" + ")} + ${event.key}`,
      };
    case InputEventType.ButtonPress:
      return {
        icon: <MousePointer className="h-3 w-3" />,
        action: "Mouse Press",
        value: event.button,
        detail: `(${Math.round(event.x)}, ${Math.round(event.y)})`,
      };
    case InputEventType.ButtonRelease:
      return {
        icon: <MousePointer className="h-3 w-3" />,
        action: "Mouse Release",
        value: event.button,
        detail: `(${Math.round(event.x)}, ${Math.round(event.y)})`,
      };
    case InputEventType.MouseMove:
      return {
        icon: <MousePointer className="h-3 w-3" />,
        action: "Mouse Move",
        value: "",
        detail: `(${Math.round(event.x)}, ${Math.round(event.y)})`,
      };
    case InputEventType.Scroll:
      return {
        icon: <Mouse className="h-3 w-3" />,
        action: "Scroll",
        value: scrollSummary(event.delta_x, event.delta_y),
        detail: "",
      };
  }
}

export function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  const time = date.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const ms = String(date.getMilliseconds()).padStart(3, "0");
  return `${time}.${ms}`;
}

/**
 * A display row over the raw event list. Consecutive high-frequency events are
 * merged into a single row so they stay readable: `scroll` rows sum the deltas
 * and count ticks; `move` rows keep the latest position and count samples. Every
 * other event is its own `event` row. Indices point back into the original
 * events array so callers can still seek/highlight the underlying events.
 */
export type EventRow =
  | { kind: "event"; index: number; event: InputEvent }
  | {
      kind: "scroll";
      startIndex: number;
      endIndex: number;
      count: number;
      deltaX: number;
      deltaY: number;
      timestamp: number;
    }
  | {
      kind: "move";
      startIndex: number;
      endIndex: number;
      count: number;
      x: number;
      y: number;
      timestamp: number;
    };

export function groupEvents(events: InputEvent[]): EventRow[] {
  const rows: EventRow[] = [];
  events.forEach((event, index) => {
    const last = rows[rows.length - 1];
    if (event.type === InputEventType.Scroll) {
      if (last?.kind === "scroll") {
        last.endIndex = index;
        last.count += 1;
        last.deltaX += event.delta_x;
        last.deltaY += event.delta_y;
      } else {
        rows.push({
          kind: "scroll",
          startIndex: index,
          endIndex: index,
          count: 1,
          deltaX: event.delta_x,
          deltaY: event.delta_y,
          timestamp: event.timestamp,
        });
      }
    } else if (event.type === InputEventType.MouseMove) {
      if (last?.kind === "move") {
        last.endIndex = index;
        last.count += 1;
        last.x = event.x;
        last.y = event.y;
      } else {
        rows.push({
          kind: "move",
          startIndex: index,
          endIndex: index,
          count: 1,
          x: event.x,
          y: event.y,
          timestamp: event.timestamp,
        });
      }
    } else {
      rows.push({ kind: "event", index, event });
    }
  });
  return rows;
}
