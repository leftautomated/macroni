import { useState, useRef, useCallback, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useRecorder } from "@/hooks/useRecorder";
import { useRecordings } from "@/hooks/useRecordings";
import { useInputEventListener } from "@/hooks/useInputEventListener";
import { useAutoResize } from "@/hooks/useAutoResize";
import { RecordingControls } from "@/components/RecordingControls";
import { LiveEventDisplay } from "@/components/LiveEventDisplay";
import { RecordingsList } from "@/components/RecordingsList";
import { RecordingDetail } from "@/components/RecordingDetail";
import { SettingsTab } from "@/components/SettingsTab";
import { VisibilityToggle } from "@/components/VisibilityToggle";
import { ExpandToggle } from "@/components/ExpandToggle";
import { Card } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { GripVertical } from "lucide-react";

const App = () => {
  const recorder = useRecorder();
  const recordingsManager = useRecordings();
  const [isExpanded, setIsExpanded] = useState(false);
  const [activeTab, setActiveTab] = useState<"live" | "recordings" | "settings">("live");
  const [lastViewedRecordingId, setLastViewedRecordingId] = useState<string | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);

  useInputEventListener(recorder.addEvent);

  // Track the last-viewed recording so we can highlight it in the list
  useEffect(() => {
    if (recordingsManager.selectedRecording) {
      setLastViewedRecordingId(recordingsManager.selectedRecording.id);
    }
  }, [recordingsManager.selectedRecording]);
  
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
      console.error("Failed to start recording:", error);
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
      console.error("Failed to stop recording:", error);
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

  const handleToggleExpand = () => {
    setIsExpanded(!isExpanded);
    // Auto-resize will handle the height adjustment via useEffect
  };

  return (
    <div className="w-screen h-screen flex overflow-hidden justify-center items-start pt-4 pb-4 bg-transparent">
      <div className="w-full max-w-5xl mx-2 space-y-3 overflow-hidden">
        <div className="flex justify-center">
          <Card ref={headerRef} className="flex items-center gap-2 px-3 py-2 w-fit" data-tauri-drag-region>
            <div className="cursor-move" data-tauri-drag-region>
              <GripVertical className="h-4 w-4 text-muted-foreground" data-tauri-drag-region />
        </div>
            <div className="h-4 w-px bg-border" data-tauri-drag-region />
        <RecordingControls
              isRecording={recorder.isRecording}
          onStartRecording={handleStartRecording}
          onStopRecording={handleStopRecording}
        />
            <div className="h-4 w-px bg-border" data-tauri-drag-region />
            <VisibilityToggle />
            <ExpandToggle isExpanded={isExpanded} onToggle={handleToggleExpand} />
          </Card>
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
                <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as "live" | "recordings" | "settings")} className="w-full">
                  <TabsList className="grid w-full grid-cols-3">
                    <TabsTrigger value="live">Live Events</TabsTrigger>
                    <TabsTrigger value="recordings">Recordings</TabsTrigger>
                    <TabsTrigger value="settings">Settings</TabsTrigger>
                  </TabsList>
                  <TabsContent value="live" className="mt-4">
                    <LiveEventDisplay events={recorder.currentEvents} />
                  </TabsContent>
                  <TabsContent value="recordings" className="mt-4">
                    <RecordingsList
                      recordings={recordingsManager.recordings}
                      selectedRecordingId={lastViewedRecordingId}
                      onViewRecording={recordingsManager.setSelectedRecording}
                      onDeleteRecording={recordingsManager.deleteRecording}
                      onOpenPlayback={(id: string) =>
                        invoke("open_playback_window", { recordingId: id })
                      }
                    />
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
