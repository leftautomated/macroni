import { useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { InputEvent, RecordingStatus } from "@/types";

export const useRecorder = () => {
  const [status, setStatus] = useState<RecordingStatus>(RecordingStatus.Idle);
  const [currentEvents, setCurrentEvents] = useState<InputEvent[]>([]);

  const startRecording = useCallback(async () => {
    await invoke("start_recording");
    setStatus(RecordingStatus.Recording);
    setCurrentEvents([]);
  }, []);

  const stopRecording = useCallback(async () => {
    const events = await invoke<InputEvent[]>("stop_recording");
    setStatus(RecordingStatus.Stopped);
    return events;
  }, []);

  const addEvent = useCallback((event: InputEvent) => {
    setCurrentEvents((prev) => [...prev, event]);
  }, []);

  const clearEvents = useCallback(() => {
    setCurrentEvents([]);
    setStatus(RecordingStatus.Idle);
  }, []);

  return {
    status,
    currentEvents,
    isRecording: status === RecordingStatus.Recording,
    startRecording,
    stopRecording,
    addEvent,
    clearEvents,
  } as const;
};
