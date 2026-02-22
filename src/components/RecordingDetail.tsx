import { useState, useRef, useCallback, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { usePlaybackPosition } from "@/hooks/usePlaybackPosition";
import { useAutoScroll } from "@/hooks/useAutoScroll";
import { useRecordingTitle } from "@/hooks/useRecordingTitle";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Recording, InputEventType } from "@/types";
import { getEventDetails, formatTimestamp } from "@/lib/event-utils";
import { X, Play, Square, Zap } from "lucide-react";

const SPEED_PRESETS = [0.5, 1, 2, 5, 10] as const;
const MAX_SPEED = 1000;

interface RecordingDetailProps {
  recording: Recording | null;
  onClose: () => void;
  onUpdateName?: (id: string, name: string) => Promise<Recording>;
  onUpdateSpeed?: (id: string, speed: number) => Promise<Recording>;
}

export const RecordingDetail = ({ recording, onClose, onUpdateName, onUpdateSpeed }: RecordingDetailProps) => {
  const [isPlaying, setIsPlaying] = useState(false);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const { titleValue, setTitleValue } = useRecordingTitle(recording, isEditingTitle);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<Map<number, HTMLTableRowElement>>(new Map());

  const handleSpeedChange = useCallback(async (speed: number) => {
    if (!recording || !onUpdateSpeed) return;
    try {
      await onUpdateSpeed(recording.id, speed);
    } catch (error) {
      console.error("Failed to update playback speed:", error);
    }
  }, [recording, onUpdateSpeed]);

  const handlePlaybackComplete = useCallback(() => {
    setIsPlaying(false);
  }, []);

  const currentPosition = usePlaybackPosition(isPlaying, handlePlaybackComplete);

  useAutoScroll(currentPosition, rowRefs);

  const handlePlay = useCallback(async () => {
    if (!recording) return;
    try {
      setIsPlaying(true);
      await invoke("play_recording", {
        events: recording.events,
        loopForever: true,
        speed: recording.playback_speed,
      });
    } catch (error) {
      console.error("Failed to play recording:", error);
      setIsPlaying(false);
    }
  }, [recording]);

  const handleStop = useCallback(async () => {
    try {
      await invoke("stop_playback");
      setIsPlaying(false);
    } catch (error) {
      console.error("Failed to stop playback:", error);
    }
  }, []);

  // Track isPlaying in a ref so the toggle-playback listener always has current state
  const isPlayingRef = useRef(isPlaying);
  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

  // Listen for global Cmd+R toggle-playback shortcut
  useEffect(() => {
    const unlisten = listen("toggle-playback", () => {
      if (isPlayingRef.current) {
        handleStop();
      } else {
        handlePlay();
      }
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [handlePlay, handleStop]);

  if (!recording) return null;

  const handleTitleDoubleClick = () => {
    setIsEditingTitle(true);
    setTitleValue(recording.name);
    setTimeout(() => {
      titleInputRef.current?.focus();
      titleInputRef.current?.select();
    }, 0);
  };

  const handleTitleBlur = async () => {
    const trimmedValue = titleValue.trim();
    setIsEditingTitle(false);

    if (trimmedValue && trimmedValue !== recording.name && onUpdateName) {
      setTitleValue(trimmedValue);
      try {
        await onUpdateName(recording.id, trimmedValue);
      } catch (error) {
        setTitleValue(recording.name);
        console.error("Failed to update recording name:", error);
      }
    } else {
      setTitleValue(recording.name);
    }
  };

  const handleTitleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.currentTarget.blur();
    } else if (e.key === "Escape") {
      setTitleValue(recording.name);
      e.currentTarget.blur();
    }
  };

  const formatDate = (timestamp: number) => {
    const date = new Date(timestamp);
    return date.toLocaleDateString('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  return (
    <div className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 flex-1 min-w-0">
            {!isPlaying ? (
              <Button variant="default" size="icon" className="h-8 w-8 shrink-0" onClick={handlePlay}>
                <Play className="h-3.5 w-3.5" />
              </Button>
            ) : (
              <Button variant="destructive" size="icon" className="h-8 w-8 shrink-0" onClick={handleStop}>
                <Square className="h-3.5 w-3.5" />
              </Button>
            )}
            <div className="flex-1 min-w-0">
              <div className="h-5 leading-tight">
                {isEditingTitle ? (
                  <input
                    ref={titleInputRef}
                    type="text"
                    value={titleValue}
                    onChange={(e) => setTitleValue(e.target.value)}
                    onBlur={handleTitleBlur}
                    onKeyDown={handleTitleKeyDown}
                    className="text-sm font-semibold bg-transparent border-none outline-none w-full px-0 py-0 m-0 h-full leading-inherit select-text"
                    style={{ caretColor: "currentColor" }}
                  />
                ) : (
                  <h3 
                    className="text-sm font-semibold truncate cursor-text h-full leading-inherit m-0"
                    onDoubleClick={handleTitleDoubleClick}
                  >
                    {titleValue}
                  </h3>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                {formatDate(recording.created_at)} · {recording.events.length} event{recording.events.length !== 1 ? 's' : ''}
              </p>
            </div>
          </div>
          <Button 
            variant="ghost" 
            size="icon" 
            className="h-7 w-7 shrink-0" 
            onClick={onClose}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
        <div className="flex items-center gap-1.5">
          {SPEED_PRESETS.map((preset) => (
            <Button
              key={preset}
              variant={recording.playback_speed === preset ? "default" : "outline"}
              size="sm"
              className="h-6 px-2 text-xs font-mono"
              onClick={() => handleSpeedChange(preset)}
              disabled={isPlaying}
            >
              {preset}x
            </Button>
          ))}
          <Button
            variant={recording.playback_speed === MAX_SPEED ? "default" : "outline"}
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => handleSpeedChange(MAX_SPEED)}
            disabled={isPlaying}
          >
            <Zap className="h-3 w-3 mr-0.5" />
            MAX
          </Button>
        </div>
      <div className="h-[376px] w-full rounded-lg border bg-muted/20 overflow-auto" ref={scrollAreaRef}>
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-muted/95 backdrop-blur supports-backdrop-filter:bg-muted/80">
            <TableRow className="border-b border-border/50 bg-muted/95">
              <TableHead className="w-[60px] text-xs">#</TableHead>
              <TableHead className="w-[40px] text-xs"></TableHead>
              <TableHead className="text-xs">Value</TableHead>
              <TableHead className="text-xs">Action</TableHead>
              <TableHead className="text-xs">Time</TableHead>
              <TableHead className="text-xs">Details</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
            {recording.events.map((event, index) => {
              const details = getEventDetails(event);
              const isCombo = event.type === InputEventType.KeyCombo;
              const prevEvent = index > 0 ? recording.events[index - 1] : null;
              const isNestedCombo = isCombo && prevEvent?.type === InputEventType.KeyPress;
              const isCurrentPosition = currentPosition === index;
              
              return (
                <TableRow 
                  key={index}
                  ref={(el) => {
                    if (el) {
                      rowRefs.current.set(index, el);
                    } else {
                      rowRefs.current.delete(index);
                    }
                  }}
                  className={`border-b border-border/30 ${
                    isNestedCombo ? 'bg-muted/10' : ''
                  } ${
                    isCurrentPosition ? 'bg-primary/20 ring-2 ring-primary/50' : ''
                  } transition-colors`}
                >
                  <TableCell className="font-medium text-xs text-muted-foreground">
                    {isNestedCombo ? '└─' : index + 1}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {details.icon}
                  </TableCell>
                  <TableCell>
                    {details.value && (
                      <span className="font-medium px-2 py-0.5 bg-secondary/50 rounded text-xs">
                        {details.value}
                    </span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {details.action}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {isNestedCombo ? '' : formatTimestamp(event.timestamp)}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {details.detail}
                  </TableCell>
                </TableRow>
              );
            })}
            </TableBody>
          </Table>
        </div>
    </div>
  );
};
