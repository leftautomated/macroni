import { Keyboard, MousePointer } from "lucide-react";
import { InputEvent, InputEventType } from "@/types";

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
  }
}

export function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  const time = date.toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const ms = String(date.getMilliseconds()).padStart(3, '0');
  return `${time}.${ms}`;
}
