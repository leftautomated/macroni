import { useRef } from "react";
import { useAutoScrollToBottom } from "@/hooks/useAutoScrollToBottom";
import { ScrollArea } from "@/components/ui/scroll-area";
import { InputEvent, InputEventType } from "@/types";
import { Keyboard, MousePointer } from "lucide-react";

interface LiveEventDisplayProps {
  events: InputEvent[];
}

export const LiveEventDisplay = ({ events }: LiveEventDisplayProps) => {
  const scrollRef = useRef<HTMLDivElement>(null);

  useAutoScrollToBottom(scrollRef, events);

  const formatTimestamp = (timestamp: number) => {
    const date = new Date(timestamp);
    const time = date.toLocaleTimeString('en-US', { 
      hour12: false, 
      hour: '2-digit', 
      minute: '2-digit', 
      second: '2-digit'
    });
    const ms = String(date.getMilliseconds()).padStart(3, '0');
    return `${time}.${ms}`;
  };

  const getEventDetails = (event: InputEvent) => {
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
  };

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold">Live Events</h3>
        <p className="text-xs text-muted-foreground">
          {events.length} event{events.length !== 1 ? 's' : ''} captured
        </p>
      </div>
      <ScrollArea ref={scrollRef} className="h-80 w-full rounded-lg border bg-muted/20 p-4">
        {events.length === 0 ? (
          <div className="h-full flex items-center justify-center">
            <p className="text-sm text-muted-foreground text-center">
              No events captured yet. 
            </p>
          </div>
        ) : (
          <div className="space-y-1">
            {events.map((event, index) => {
              const details = getEventDetails(event);
              const isCombo = event.type === InputEventType.KeyCombo;
              const prevEvent = index > 0 ? events[index - 1] : null;
              const isNestedCombo = isCombo && prevEvent?.type === InputEventType.KeyPress;
              
              return (
                <div
                  key={index}
                  className={`flex items-center gap-3 text-sm font-mono ${isNestedCombo ? 'opacity-75' : ''}`}
                >
                  <span className="text-muted-foreground w-[60px] text-xs">
                    {isNestedCombo ? '└─' : index + 1}
                  </span>
                  <span className="text-muted-foreground w-[40px] flex items-center">
                    {details.icon}
                  </span>
                  {details.value && (
                    <span className="font-medium px-2 py-0.5 bg-secondary/50 rounded text-xs">
                      {details.value}
                    </span>
                  )}
                  <span className="text-xs text-muted-foreground min-w-[100px]">
                    {details.action}
                  </span>
                  {!isNestedCombo && (
                    <span className="text-muted-foreground min-w-[110px] text-xs font-mono">
                      {formatTimestamp(event.timestamp)}
                    </span>
                  )}
                  {details.detail && (
                    <span className="text-xs text-muted-foreground font-mono">
                      {details.detail}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </ScrollArea>
    </div>
  );
};

