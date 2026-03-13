import { useRef } from "react";
import { useAutoScrollToBottom } from "@/hooks/useAutoScrollToBottom";
import { ScrollArea } from "@/components/ui/scroll-area";
import { InputEvent, InputEventType } from "@/types";
import { getEventDetails, formatTimestamp } from "@/lib/event-utils";

interface LiveEventDisplayProps {
  events: InputEvent[];
}

export const LiveEventDisplay = ({ events }: LiveEventDisplayProps) => {
  const scrollRef = useRef<HTMLDivElement>(null);

  useAutoScrollToBottom(scrollRef, events);

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
          <div className="h-full flex flex-col items-center justify-center gap-1">
            <p className="text-sm text-muted-foreground">No events captured yet.</p>
            <p className="text-xs text-muted-foreground">
              Press <kbd className="font-mono px-1.5 py-0.5 rounded bg-secondary/50">{navigator.userAgent.includes("Mac") ? "⌘" : "Ctrl"} + Shift + R</kbd> to start recording
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

