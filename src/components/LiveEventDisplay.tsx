import { useRef } from "react";
import { Mouse, MousePointer } from "lucide-react";
import { useAutoScrollToBottom } from "@/hooks/useAutoScrollToBottom";
import { ScrollArea } from "@/components/ui/scroll-area";
import { type InputEvent, InputEventType } from "@/types";
import { formatTimestamp, getEventDetails, groupEvents, scrollSummary } from "@/lib/event-utils";

interface LiveEventDisplayProps {
  events: InputEvent[];
}

export const LiveEventDisplay = ({ events }: LiveEventDisplayProps) => {
  const scrollRef = useRef<HTMLDivElement>(null);

  useAutoScrollToBottom(scrollRef, events);

  const rows = groupEvents(events);

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold">Live Events</h3>
        <p className="text-xs text-muted-foreground">
          {events.length} event{events.length !== 1 ? "s" : ""} captured
        </p>
      </div>
      <ScrollArea ref={scrollRef} className="h-80 w-full rounded-lg border bg-muted/20 p-4">
        {events.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center gap-1">
            <p className="text-sm text-muted-foreground">No events captured yet.</p>
            <p className="text-xs text-muted-foreground">
              Press{" "}
              <kbd className="font-mono px-1.5 py-0.5 rounded bg-secondary/50">
                {navigator.userAgent.includes("Mac") ? "⌘" : "Ctrl"} + Shift + R
              </kbd>{" "}
              to start recording
            </p>
          </div>
        ) : (
          <div className="space-y-1">
            {rows.map((row, rowIdx) => {
              if (row.kind === "scroll") {
                return (
                  <div
                    key={`s${row.startIndex}`}
                    className="flex items-center gap-3 text-sm font-mono"
                  >
                    <span className="text-muted-foreground w-[60px] text-xs">
                      {row.startIndex + 1}
                    </span>
                    <span className="text-muted-foreground w-[40px] flex items-center">
                      <Mouse className="h-3 w-3" />
                    </span>
                    <span className="font-medium px-2 py-0.5 bg-secondary/50 rounded text-xs">
                      {scrollSummary(row.deltaX, row.deltaY)}
                    </span>
                    <span className="text-xs text-muted-foreground min-w-[100px]">
                      Scroll{row.count > 1 ? ` ×${row.count}` : ""}
                    </span>
                    <span className="text-muted-foreground min-w-[110px] text-xs font-mono">
                      {formatTimestamp(row.timestamp)}
                    </span>
                  </div>
                );
              }

              if (row.kind === "move") {
                return (
                  <div
                    key={`m${row.startIndex}`}
                    className="flex items-center gap-3 text-sm font-mono"
                  >
                    <span className="text-muted-foreground w-[60px] text-xs">
                      {row.startIndex + 1}
                    </span>
                    <span className="text-muted-foreground w-[40px] flex items-center">
                      <MousePointer className="h-3 w-3" />
                    </span>
                    <span className="text-xs text-muted-foreground min-w-[100px]">
                      Mouse Move{row.count > 1 ? ` ×${row.count}` : ""}
                    </span>
                    <span className="text-muted-foreground min-w-[110px] text-xs font-mono">
                      {formatTimestamp(row.timestamp)}
                    </span>
                    <span className="text-xs text-muted-foreground font-mono">
                      ({Math.round(row.x)}, {Math.round(row.y)})
                    </span>
                  </div>
                );
              }

              if (row.kind === "click") {
                return (
                  <div
                    key={`c${row.startIndex}`}
                    className="flex items-center gap-3 text-sm font-mono"
                  >
                    <span className="text-muted-foreground w-[60px] text-xs">
                      {row.startIndex + 1}
                    </span>
                    <span className="text-muted-foreground w-[40px] flex items-center">
                      <MousePointer className="h-3 w-3" />
                    </span>
                    <span className="font-medium px-2 py-0.5 bg-secondary/50 rounded text-xs">
                      {row.button}
                    </span>
                    <span className="text-xs text-muted-foreground min-w-[100px]">Click</span>
                    <span className="text-muted-foreground min-w-[110px] text-xs font-mono">
                      {formatTimestamp(row.timestamp)}
                    </span>
                    <span className="text-xs text-muted-foreground font-mono">
                      ({Math.round(row.x)}, {Math.round(row.y)})
                    </span>
                  </div>
                );
              }

              const event = row.event;
              const details = getEventDetails(event);
              const isCombo = event.type === InputEventType.KeyCombo;
              const prevRow = rowIdx > 0 ? rows[rowIdx - 1] : null;
              const isNestedCombo =
                isCombo &&
                prevRow?.kind === "event" &&
                prevRow.event.type === InputEventType.KeyPress;

              return (
                <div
                  key={`e${row.index}`}
                  className={`flex items-center gap-3 text-sm font-mono ${isNestedCombo ? "opacity-75" : ""}`}
                >
                  <span className="text-muted-foreground w-[60px] text-xs">
                    {isNestedCombo ? "└─" : row.index + 1}
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
