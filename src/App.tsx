import { useState, useRef, useCallback, useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useRecorder } from "@/hooks/useRecorder";
import { useRecordings } from "@/hooks/useRecordings";
import { useInputEventListener } from "@/hooks/useInputEventListener";
import { useAutoResize } from "@/hooks/useAutoResize";
import { usePermissionStatus } from "@/hooks/usePermissionStatus";
import { RecordingControls } from "@/components/RecordingControls";
import { VisibilityToggle } from "@/components/VisibilityToggle";
import { PermissionAlert } from "@/components/PermissionAlert";
import { PermissionGate } from "@/components/PermissionGate";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { invoke, logEvent } from "@/lib/observability";
import type { Recording } from "@/types";
import { Clapperboard, GripVertical, Square } from "lucide-react";

const isMac = typeof navigator !== "undefined" && navigator.userAgent.includes("Mac");

const App = () => {
  const recorder = useRecorder();
  const recordingsManager = useRecordings();
  const permissions = usePermissionStatus();
  const [isPlaying, setIsPlaying] = useState(false);
  const [replayName, setReplayName] = useState<string | null>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // Last recording the Studio asked us to replay — re-played on Cmd+R.
  const replayRecRef = useRef<Recording | null>(null);

  useInputEventListener(recorder.addEvent);

  const permissionsComplete =
    !isMac ||
    (permissions.state.accessibility === true && permissions.state.screenRecording === true);
  const showPermissionGate = !permissionsComplete;

  // The overlay is just a bar now — never expands. Auto-resize still tracks the
  // header so the window grows for the permission gate/alert.
  useAutoResize({
    isExpanded: false,
    headerRef,
    contentRef,
    dependencies: [
      permissions.state.accessibility,
      permissions.state.screenRecording,
      showPermissionGate,
      isPlaying,
    ],
  });

  const handleStartRecording = useCallback(async () => {
    if (!permissionsComplete) {
      if (permissions.state.accessibility !== true) {
        await permissions.openAccessibilitySettings();
      } else if (permissions.state.screenRecording !== true) {
        await permissions.openScreenRecordingSettings();
      }
      return;
    }

    try {
      // Stop any active playback before starting a new recording
      try {
        await invoke("stop_playback");
      } catch {
        // Ignore — playback may not be active
      }
      await recorder.startRecording();
    } catch (error) {
      logEvent("error", "recording", "start_failed", { error });
    }
  }, [permissions, permissionsComplete, recorder]);

  const handleStopRecording = useCallback(async () => {
    try {
      const result = await recorder.stopRecording();
      if (result.events.length > 0 || result.video) {
        // Save it; it lives in the Studio now (no detail panel in the overlay).
        await recordingsManager.saveRecording(
          result.id,
          "Untitled",
          result.events,
          result.video ?? undefined,
        );
        recorder.clearEvents();
      }
    } catch (error) {
      logEvent("error", "recording", "stop_failed", { error });
    }
  }, [recorder, recordingsManager]);

  const handlePlay = useCallback(async (rec: Recording) => {
    try {
      setIsPlaying(true);
      setReplayName(rec.name && rec.name !== "Untitled" ? rec.name : null);
      replayRecRef.current = rec;
      await invoke("play_recording", {
        events: rec.events,
        loopForever: false,
        speed: rec.playback_speed,
      });
    } catch (error) {
      logEvent("error", "playback", "play_failed", {
        error,
        fields: { recordingId: rec.id, eventCount: rec.events.length },
      });
      setIsPlaying(false);
    }
  }, []);

  const handleStopPlayback = useCallback(async () => {
    try {
      await invoke("stop_playback");
      setIsPlaying(false);
    } catch (error) {
      logEvent("error", "playback", "stop_failed", { error });
    }
  }, []);

  // Keep current recording/playing state in refs for the shortcut listeners.
  const isRecordingRef = useRef(recorder.isRecording);
  useEffect(() => {
    isRecordingRef.current = recorder.isRecording;
  }, [recorder.isRecording]);
  const isPlayingRef = useRef(isPlaying);
  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

  // Cmd+Shift+R — toggle recording.
  useEffect(() => {
    const unlisten = listen("toggle-recording", () => {
      if (isRecordingRef.current) {
        handleStopRecording();
      } else {
        handleStartRecording();
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [handleStartRecording, handleStopRecording]);

  // Cmd+R — replay the last target (the backend emits this only when idle).
  useEffect(() => {
    const unlisten = listen("toggle-playback", () => {
      if (!isPlayingRef.current && replayRecRef.current) {
        void handlePlay(replayRecRef.current);
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [handlePlay]);

  // Playback ended (naturally, or stopped from the backend).
  useEffect(() => {
    const unlistenComplete = listen("playback-complete", () => setIsPlaying(false));
    const unlistenStopped = listen("playback-stopped", () => setIsPlaying(false));
    return () => {
      unlistenComplete.then((fn) => fn());
      unlistenStopped.then((fn) => fn());
    };
  }, []);

  // The Studio hands a recording here to replay it — the overlay's
  // non-activating panel is the focus-safe surface, so auto-play immediately.
  useEffect(() => {
    const unlisten = listen<string>("replay-recording", async (event) => {
      const all = await invoke<Recording[]>("load_recordings");
      const rec = all.find((r) => r.id === event.payload);
      if (rec) void handlePlay(rec);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [handlePlay]);

  return (
    <div className="w-screen h-screen flex overflow-hidden justify-center items-start pt-4 pb-4 bg-transparent">
      <div className="w-full max-w-5xl mx-2 space-y-3 overflow-hidden">
        <div ref={headerRef} className="flex flex-col items-center gap-2">
          {showPermissionGate ? (
            <PermissionGate
              accessibility={permissions.state.accessibility}
              screenRecording={permissions.state.screenRecording}
              activeAssistantPanel={permissions.activeAssistantPanel}
              onOpenAccessibilitySettings={permissions.openAccessibilitySettings}
              onOpenScreenRecordingSettings={permissions.openScreenRecordingSettings}
            />
          ) : (
            <>
              <Card className="flex items-center gap-2 px-3 py-2 w-fit" data-tauri-drag-region>
                <div className="cursor-move" data-tauri-drag-region>
                  <GripVertical className="h-4 w-4 text-muted-foreground" data-tauri-drag-region />
                </div>
                <div className="h-4 w-px bg-border" data-tauri-drag-region />
                {isPlaying ? (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground whitespace-nowrap">
                      Playing{replayName ? ` · ${replayName}` : "…"}
                    </span>
                    <Button
                      variant="destructive"
                      size="sm"
                      className="h-7"
                      onClick={handleStopPlayback}
                    >
                      <Square className="h-3 w-3 mr-1" /> Stop
                    </Button>
                  </div>
                ) : (
                  <RecordingControls
                    isRecording={recorder.isRecording}
                    isProcessing={recorder.isProcessing}
                    onStartRecording={handleStartRecording}
                    onStopRecording={handleStopRecording}
                  />
                )}
                <div className="h-4 w-px bg-border" data-tauri-drag-region />
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() => void invoke("focus_studio_window")}
                  title="Open Studio — browse and play recordings"
                >
                  <Clapperboard className="h-4 w-4" />
                </Button>
                <VisibilityToggle />
              </Card>
              <PermissionAlert
                screenRecording={permissions.state.screenRecording}
                accessibility={permissions.state.accessibility}
                needsScreenRecording={permissions.state.needsScreenRecording}
                needsAccessibility={permissions.state.needsAccessibility}
                captureError={permissions.state.captureError}
                onOpenScreenRecordingSettings={permissions.openScreenRecordingSettings}
                onOpenAccessibilitySettings={permissions.openAccessibilitySettings}
                onDismissPermission={permissions.dismissPermissionPrompt}
                onDismissCaptureError={permissions.dismissCaptureError}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default App;
