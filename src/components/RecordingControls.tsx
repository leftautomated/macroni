import { Button } from "@/components/ui/button";
import { Circle, Square } from "lucide-react";

interface RecordingControlsProps {
  isRecording: boolean;
  onStartRecording: () => void;
  onStopRecording: () => void;
}

export const RecordingControls = ({
  isRecording,
  onStartRecording,
  onStopRecording,
}: RecordingControlsProps) => {
  if (!isRecording) {
    return (
      <Button
        onClick={onStartRecording}
        size="sm"
        className="gap-1.5 h-7 px-3 text-xs"
      >
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

