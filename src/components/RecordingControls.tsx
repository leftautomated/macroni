import { Button } from "@/components/ui/button";
import { Circle, Loader2, Play, Square } from "lucide-react";

interface RecordingControlsProps {
  isRecording: boolean;
  isProcessing?: boolean;
  isPlaying?: boolean;
  canPlay?: boolean;
  playbackName?: string | null;
  onStartRecording: () => void;
  onStopRecording: () => void;
  onStartPlayback?: () => void;
  onStopPlayback?: () => void;
}

export const RecordingControls = ({
  isRecording,
  isProcessing = false,
  isPlaying = false,
  canPlay = false,
  playbackName,
  onStartRecording,
  onStopRecording,
  onStartPlayback = () => {},
  onStopPlayback = () => {},
}: RecordingControlsProps) => {
  return (
    <div className="flex items-center gap-1.5">
      <Button
        aria-label={isRecording ? "Stop recording" : "Record macro"}
        disabled={isProcessing || isPlaying}
        onClick={isRecording ? onStopRecording : onStartRecording}
        variant={isRecording ? "destructive" : "default"}
        size="sm"
        className="gap-1.5 h-7 px-3 text-xs"
        title={isRecording ? "Stop recording" : "Record a new macro"}
      >
        {isProcessing ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : isRecording ? (
          <Square className="h-3 w-3 fill-current" />
        ) : (
          <Circle className="h-3 w-3 fill-current" />
        )}
        {isProcessing ? "Saving…" : isRecording ? "Stop" : "Record"}
      </Button>
      <Button
        aria-label={isPlaying ? "Stop playing macro" : "Play current macro"}
        disabled={isProcessing || isRecording || (!isPlaying && !canPlay)}
        onClick={isPlaying ? onStopPlayback : onStartPlayback}
        variant={isPlaying ? "destructive" : "secondary"}
        size="sm"
        className="gap-1.5 h-7 px-3 text-xs"
        title={
          isPlaying
            ? "Stop playing macro"
            : canPlay
              ? `Play ${playbackName || "current macro"}`
              : "Record a macro to enable playback"
        }
      >
        {isPlaying ? (
          <Square className="h-3 w-3 fill-current" />
        ) : (
          <Play className="h-3 w-3 fill-current" />
        )}
        {isPlaying ? "Stop" : "Play"}
      </Button>
    </div>
  );
};
