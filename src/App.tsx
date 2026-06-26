import { useState, useRef, useCallback, useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useRecorder } from "@/hooks/useRecorder";
import { useRecordings } from "@/hooks/useRecordings";
import { useInputEventListener } from "@/hooks/useInputEventListener";
import { useAutoResize } from "@/hooks/useAutoResize";
import { usePermissionStatus } from "@/hooks/usePermissionStatus";
import { RecordingControls } from "@/components/RecordingControls";
import { LiveEventDisplay } from "@/components/LiveEventDisplay";
import { RecordingDetail } from "@/components/RecordingDetail";
import { SettingsTab } from "@/components/SettingsTab";
import { VisibilityToggle } from "@/components/VisibilityToggle";
import { ExpandToggle } from "@/components/ExpandToggle";
import { PermissionAlert } from "@/components/PermissionAlert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { invoke, logEvent } from "@/lib/observability";
import type { Recording } from "@/types";
import { Clapperboard, GripVertical } from "lucide-react";

const App = () => {
  const recorder = useRecorder();
  const recordingsManager = useRecordings();
  const permissions = usePermissionStatus();
  const [isExpanded, setIsExpanded] = useState(false);
  const [activeTab, setActiveTab] = useState<"live" | "settings">("live");
  const contentRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);

  useInputEventListener(recorder.addEvent);

  useAutoResize({
    isExpanded,
    headerRef,
    contentRef,
    dependencies: [recordingsManager.selectedRecording, activeTab],
  });

  const handleStartRecording = useCallback(async () => {
    try {
      // Stop any active playback before starting a new recording
      try {
        await invoke("stop_playback");
      } catch {
        // Ignore — playback may not be active
      }
      await recorder.startRecording();
      recordingsManager.setSelectedRecording(null);
    } catch (error) {
      logEvent("error", "recording", "start_failed", { error });
    }
  }, [recorder, recordingsManager]);

  const handleStopRecording = useCallback(async () => {
    try {
      const result = await recorder.stopRecording();
      if (result.events.length > 0 || result.video) {
        const newRecording = await recordingsManager.saveRecording(
          result.id,
          "Untitled",
          result.events,
          result.video ?? undefined,
        );
        recorder.clearEvents();
        recordingsManager.setSelectedRecording(newRecording);
        setIsExpanded(true);
      }
    } catch (error) {
      logEvent("error", "recording", "stop_failed", { error });
    }
  }, [recorder, recordingsManager]);

  // Track isRecording in a ref so the toggle-recording listener always has current state
  const isRecordingRef = useRef(recorder.isRecording);
  useEffect(() => {
    isRecordingRef.current = recorder.isRecording;
  }, [recorder.isRecording]);

  // Listen for global Cmd+Shift+R toggle-recording shortcut
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

  // The Studio hands a recording back here to replay it (the main panel is the
  // focus-safe surface). Load it fresh and expand so the user can press Play.
  useEffect(() => {
    const unlisten = listen<string>("replay-recording", async (event) => {
      const all = await invoke<Recording[]>("load_recordings");
      const rec = all.find((r) => r.id === event.payload);
      if (rec) {
        recordingsManager.setSelectedRecording(rec);
        setIsExpanded(true);
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [recordingsManager.setSelectedRecording]);

  const handleToggleExpand = () => {
    setIsExpanded(!isExpanded);
    // Auto-resize will handle the height adjustment via useEffect
  };

  return (
    <div className="w-screen h-screen flex overflow-hidden justify-center items-start pt-4 pb-4 bg-transparent">
      <div className="w-full max-w-5xl mx-2 space-y-3 overflow-hidden">
        <div ref={headerRef} className="flex flex-col items-center gap-2">
          <Card className="flex items-center gap-2 px-3 py-2 w-fit" data-tauri-drag-region>
            <div className="cursor-move" data-tauri-drag-region>
              <GripVertical className="h-4 w-4 text-muted-foreground" data-tauri-drag-region />
            </div>
            <div className="h-4 w-px bg-border" data-tauri-drag-region />
            <RecordingControls
              isRecording={recorder.isRecording}
              isProcessing={recorder.isProcessing}
              onStartRecording={handleStartRecording}
              onStopRecording={handleStopRecording}
            />
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
            <ExpandToggle isExpanded={isExpanded} onToggle={handleToggleExpand} />
          </Card>
          <PermissionAlert
            screenRecording={permissions.state.screenRecording}
            accessibility={permissions.state.accessibility}
            needsScreenRecording={permissions.state.needsScreenRecording}
            needsAccessibility={permissions.state.needsAccessibility}
            captureError={permissions.state.captureError}
            onRequestPermissions={permissions.requestPermissions}
            onOpenScreenRecordingSettings={permissions.openScreenRecordingSettings}
            onOpenAccessibilitySettings={permissions.openAccessibilitySettings}
            onRecheck={permissions.recheck}
            onDismissPermission={permissions.dismissPermissionPrompt}
            onDismissCaptureError={permissions.dismissCaptureError}
          />
        </div>

        {isExpanded && (
          <div ref={contentRef}>
            {recordingsManager.selectedRecording ? (
              <Card className="p-4">
                <RecordingDetail
                  recording={recordingsManager.selectedRecording}
                  onClose={() => recordingsManager.setSelectedRecording(null)}
                  onUpdateName={recordingsManager.updateRecordingName}
                  onUpdateSpeed={recordingsManager.updateRecordingSpeed}
                />
              </Card>
            ) : (
              <Card className="p-4">
                <Tabs
                  value={activeTab}
                  onValueChange={(value) => setActiveTab(value as "live" | "settings")}
                  className="w-full"
                >
                  <TabsList className="grid w-full grid-cols-2">
                    <TabsTrigger value="live">Live Events</TabsTrigger>
                    <TabsTrigger value="settings">Settings</TabsTrigger>
                  </TabsList>
                  <TabsContent value="live" className="mt-4">
                    <LiveEventDisplay events={recorder.currentEvents} />
                  </TabsContent>
                  <TabsContent value="settings" className="mt-4">
                    <SettingsTab />
                  </TabsContent>
                </Tabs>
              </Card>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default App;
