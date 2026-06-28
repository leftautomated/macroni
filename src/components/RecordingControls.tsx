import { Button } from "@/components/ui/button";
import { Circle, Loader2, Square } from "lucide-react";

interface RecordingControlsProps {
  isRecording: boolean;
  isProcessing?: boolean;
  onStartRecording: () => void;
  onStopRecording: () => void;
}

export const RecordingControls = ({
  isRecording,
  isProcessing = false,
  onStartRecording,
  onStopRecording,
}: RecordingControlsProps) => {
  if (isProcessing) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground px-2 h-7">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Saving…
      </div>
    );
  }

  if (!isRecording) {
    return (
      <Button onClick={onStartRecording} size="sm" className="gap-1.5 h-7 px-3 text-xs">
        <Circle className="h-3 w-3 fill-current" />
        Start
      </Button>
    );
  }

  return (
    <>
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <div className="h-1.5 w-1.5 rounded-full bg-red-500 animate-pulse" />
        Recording
      </div>
      <Button
        onClick={onStopRecording}
        variant="destructive"
        size="sm"
        className="gap-1.5 h-7 px-3 text-xs"
      >
        <Square className="h-3 w-3 fill-current" />
        Stop
      </Button>
    </>
  );
};
