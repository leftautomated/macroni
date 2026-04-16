import { useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { InputEvent, RecordingStatus, VideoMetadata } from "@/types";

interface StopResult {
  id: string;
  events: InputEvent[];
  video: VideoMetadata | null;
}

export const useRecorder = () => {
  const [status, setStatus] = useState<RecordingStatus>(RecordingStatus.Idle);
  const [currentEvents, setCurrentEvents] = useState<InputEvent[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);

  const startRecording = useCallback(async () => {
    const id = await invoke<string>("start_recording");
    setCurrentId(id);
    setStatus(RecordingStatus.Recording);
    setCurrentEvents([]);
  }, []);

  const stopRecording = useCallback(async () => {
    const result = await invoke<StopResult>("stop_recording");
    setStatus(RecordingStatus.Stopped);
    return result;
  }, []);

  const addEvent = useCallback((event: InputEvent) => {
    setCurrentEvents((prev) => [...prev, event]);
  }, []);

  const clearEvents = useCallback(() => {
    setCurrentEvents([]);
    setStatus(RecordingStatus.Idle);
    setCurrentId(null);
  }, []);

  return {
    status,
    currentEvents,
    currentId,
    isRecording: status === RecordingStatus.Recording,
    startRecording,
    stopRecording,
    addEvent,
    clearEvents,
  } as const;
};
