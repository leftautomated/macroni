import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Recording } from "@/types";
import { Trash2 } from "lucide-react";

interface RecordingsListProps {
  recordings: Recording[];
  selectedRecordingId?: string | null;
  onViewRecording: (recording: Recording) => void;
  onDeleteRecording: (id: string) => void;
}

export const RecordingsList = ({
  recordings,
  selectedRecordingId,
  onViewRecording,
  onDeleteRecording,
}: RecordingsListProps) => {
  const formatDate = (timestamp: number) => {
    const date = new Date(timestamp);
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold">Saved Recordings</h3>
        <p className="text-xs text-muted-foreground">
          {recordings.length} recording{recordings.length !== 1 ? 's' : ''} saved
        </p>
      </div>
        {recordings.length === 0 ? (
        <div className="h-80 flex items-center justify-center border rounded-lg bg-muted/20">
          <p className="text-sm text-muted-foreground text-center">
            No recordings saved yet.
          </p>
        </div>
        ) : (
          <ScrollArea className="h-80 w-full rounded-lg border bg-muted/20 p-4">
            <div className="space-y-2">
            {recordings.map((recording) => {
              const isSelected = selectedRecordingId === recording.id;
              return (
                <div
                  key={recording.id}
                  className={`flex items-center justify-between p-3 rounded-lg border transition-colors ${
                    isSelected
                      ? 'border-primary/50 bg-primary/10'
                      : 'bg-muted/20 hover:bg-muted/40'
                  }`}
                >
                  <div
                    className="flex-1 min-w-0 cursor-pointer"
                    onClick={() => onViewRecording(recording)}
                  >
                    <div className="flex items-center gap-2">
                      {isSelected && (
                        <div className="h-2 w-2 rounded-full bg-primary shrink-0" />
                      )}
                      <h4 className="font-medium text-sm truncate">
                        {recording.name}
                      </h4>
                    </div>
                    <div className={`flex items-center gap-3 mt-0.5 ${isSelected ? 'ml-4' : ''}`}>
                      <p className="text-xs text-muted-foreground">
                        {recording.events.length} event{recording.events.length !== 1 ? 's' : ''}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {formatDate(recording.created_at)}
                      </p>
                      {recording.playback_speed !== 1 && (
                        <p className="text-xs text-muted-foreground font-mono">
                          {recording.playback_speed >= MAX_SPEED ? 'MAX' : `${recording.playback_speed}x`}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 hover:text-destructive"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeleteRecording(recording.id);
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              );
            })}
            </div>
          </ScrollArea>
        )}
    </div>
  );
};

const MAX_SPEED = 1000;
