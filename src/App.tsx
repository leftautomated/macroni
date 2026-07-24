import { useState, useRef, useCallback, useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useRecorder } from "@/hooks/useRecorder";
import { useRecordings } from "@/hooks/useRecordings";
import { useAutoResize } from "@/hooks/useAutoResize";
import { usePermissionStatus } from "@/hooks/usePermissionStatus";
import { useClicker } from "@/hooks/useClicker";
import { ClickerPanel } from "@/components/ClickerPanel";
import { RecordingControls } from "@/components/RecordingControls";
import { VisibilityToggle } from "@/components/VisibilityToggle";
import { PermissionAlert } from "@/components/PermissionAlert";
import { PermissionGate } from "@/components/PermissionGate";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { invoke, logEvent } from "@/lib/observability";
import { recordingWithinTrim } from "@/lib/recording-trim";
import { subscribeReplaySelection } from "@/lib/replay-selection";
import type { Recording } from "@/types";
import { Clapperboard, GripVertical, MousePointerClick } from "lucide-react";

const isMac = typeof navigator !== "undefined" && navigator.userAgent.includes("Mac");

type ReplayRecordingPayload =
  | string
  | {
      id: string;
      loopForever?: boolean;
      trimStartMs?: number | null;
      trimEndMs?: number | null;
    };

function normalizeReplayPayload(payload: ReplayRecordingPayload) {
  if (typeof payload === "string") {
    return { id: payload, loopForever: true, trimStartMs: undefined, trimEndMs: undefined };
  }
  return {
    id: payload.id,
    loopForever: payload.loopForever ?? true,
    trimStartMs: payload.trimStartMs,
    trimEndMs: payload.trimEndMs,
  };
}

const App = () => {
  const recorder = useRecorder();
  const recordingsManager = useRecordings();
  const permissions = usePermissionStatus();
  const clicker = useClicker();
  const [isPlaying, setIsPlaying] = useState(false);
  const [isClickerOpen, setIsClickerOpen] = useState(false);
  const [currentRecording, setCurrentRecording] = useState<Recording | null>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // Current playback target — also re-played by Cmd+R.
  const replayRecRef = useRef<Recording | null>(null);
  const replayLoopForeverRef = useRef(true);
  const replayTrimRef = useRef<{ id: string; a: number; b: number } | null>(null);

  useEffect(() => {
    setCurrentRecording((current) => {
      if (current) {
        const refreshed = recordingsManager.recordings.find(
          (recording) => recording.id === current.id,
        );
        if (refreshed) {
          const savedTrim = replayTrimRef.current;
          return savedTrim?.id === refreshed.id
            ? recordingWithinTrim(refreshed, savedTrim)
            : refreshed;
        }
      }
      return recordingsManager.recordings[0] ?? null;
    });
  }, [recordingsManager.recordings]);

  useEffect(() => {
    replayRecRef.current = currentRecording;
  }, [currentRecording]);

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
      isClickerOpen,
      clicker.status,
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
        const saved = await recordingsManager.saveRecording(
          result.id,
          "Untitled",
          result.events,
          result.video ?? undefined,
        );
        setCurrentRecording(saved);
        replayTrimRef.current = null;
        replayLoopForeverRef.current = true;
        recorder.clearEvents();
      }
    } catch (error) {
      logEvent("error", "recording", "stop_failed", { error });
    }
  }, [recorder, recordingsManager]);

  const handlePlay = useCallback(async (rec: Recording, loopForever = true) => {
    try {
      setIsPlaying(true);
      replayRecRef.current = rec;
      replayLoopForeverRef.current = loopForever;
      await invoke("play_recording", {
        events: rec.events,
        loopForever,
        speed: rec.playback_speed,
      });
    } catch (error) {
      logEvent("error", "playback", "play_failed", {
        error,
        fields: { recordingId: rec.id, eventCount: rec.events.length, loopForever },
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

  const handlePermissionGateClose = useCallback(async () => {
    try {
      await permissions.dismissPermissionAssistant();
      await invoke<boolean>("toggle_visibility");
    } catch (error) {
      logEvent("error", "window", "permission_gate_close_failed", { error });
    }
  }, [permissions]);

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

  // Recording stopped from the backend (global shortcut). Rust already
  // stopped, finalized, and auto-saved it — the frontend only refreshes its
  // list and resets local status. Do NOT save here.
  const { clearEvents } = recorder;
  const { loadRecordings } = recordingsManager;
  useEffect(() => {
    const unlisten = listen<string | null>("recording-stopped", async (event) => {
      clearEvents();
      const refreshed = await loadRecordings();
      const stopped = refreshed.find((recording) => recording.id === event.payload) ?? refreshed[0];
      if (stopped) {
        setCurrentRecording(stopped);
        replayTrimRef.current = null;
        replayLoopForeverRef.current = true;
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [clearEvents, loadRecordings]);

  // Cmd+R — replay the last target (the backend emits this only when idle).
  useEffect(() => {
    const unlisten = listen("toggle-playback", () => {
      if (!isPlayingRef.current && replayRecRef.current) {
        void handlePlay(replayRecRef.current, replayLoopForeverRef.current);
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

  const selectReplayRecording = useCallback(async (payload: ReplayRecordingPayload) => {
    const { id, loopForever, trimStartMs, trimEndMs } = normalizeReplayPayload(payload);
    const all = await invoke<Recording[]>("load_recordings");
    const rec = all.find((r) => r.id === id);
    if (rec) {
      replayTrimRef.current =
        trimStartMs != null && trimEndMs != null ? { id, a: trimStartMs, b: trimEndMs } : null;
      const replayRecording =
        trimStartMs != null && trimEndMs != null
          ? recordingWithinTrim(rec, { a: trimStartMs, b: trimEndMs })
          : rec;
      setCurrentRecording(replayRecording);
      replayLoopForeverRef.current = loopForever;
    }
  }, []);

  // Explicit replay requests still arrive from the backend. Selection-only
  // synchronization stays in the web layer so it cannot deadlock Tauri while
  // the sibling Studio webview is loading.
  useEffect(() => {
    const unlistenReplay = listen<ReplayRecordingPayload>(
      "replay-recording",
      (event) => void selectReplayRecording(event.payload),
    );
    return () => {
      unlistenReplay.then((fn) => fn());
    };
  }, [selectReplayRecording]);

  useEffect(
    () => subscribeReplaySelection((recordingId) => void selectReplayRecording(recordingId)),
    [selectReplayRecording],
  );

  const handlePlayCurrent = useCallback(() => {
    if (currentRecording) {
      void handlePlay(currentRecording, replayLoopForeverRef.current);
    }
  }, [currentRecording, handlePlay]);

  return (
    <div className="w-screen h-screen flex overflow-hidden justify-center items-start pt-4 pb-4 bg-transparent">
      <div className="w-full max-w-5xl mx-2 space-y-3 overflow-hidden">
        <div ref={headerRef} className="flex flex-col items-center gap-2">
          {showPermissionGate ? (
            <PermissionGate
              accessibility={permissions.state.accessibility}
              screenRecording={permissions.state.screenRecording}
              activeAssistantPanel={permissions.activeAssistantPanel}
              onClose={handlePermissionGateClose}
              onOpenAccessibilitySettings={permissions.openAccessibilitySettings}
              onOpenScreenRecordingSettings={permissions.openScreenRecordingSettings}
            />
          ) : (
            <>
              <Card className="flex items-center gap-2 px-3 py-2 w-fit" data-tauri-drag-region>
                <div className="cursor-move" data-tauri-drag-region="deep" title="Drag Macroni">
                  <GripVertical className="h-4 w-4 text-muted-foreground" />
                </div>
                <div className="h-4 w-px bg-border" data-tauri-drag-region />
                <RecordingControls
                  canPlay={currentRecording !== null}
                  isPlaying={isPlaying}
                  isRecording={recorder.isRecording}
                  isProcessing={recorder.isProcessing}
                  onStartPlayback={handlePlayCurrent}
                  onStartRecording={handleStartRecording}
                  onStopPlayback={handleStopPlayback}
                  onStopRecording={handleStopRecording}
                  playbackName={currentRecording?.name}
                />
                <div className="h-4 w-px bg-border" data-tauri-drag-region />
                <Button
                  variant="ghost"
                  size="icon"
                  className={`h-7 w-7 ${
                    clicker.status !== "idle" ? "bg-primary/15 text-primary" : ""
                  }`}
                  onClick={() => setIsClickerOpen((open) => !open)}
                  aria-label={isClickerOpen ? "Close auto clicker" : "Open auto clicker"}
                  title="Auto clicker"
                >
                  <MousePointerClick className="h-4 w-4" />
                </Button>
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
              {isClickerOpen && (
                <ClickerPanel
                  config={clicker.config}
                  disabled={recorder.isRecording || recorder.isProcessing || isPlaying}
                  error={clicker.error}
                  onChange={clicker.setConfig}
                  onStart={() => void clicker.start()}
                  onStop={() => void clicker.stop()}
                  status={clicker.status}
                />
              )}
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
