import { useState, useCallback, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Recording, InputEvent } from "@/types";

export const useRecordings = () => {
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [selectedRecording, setSelectedRecording] = useState<Recording | null>(null);

  const loadRecordings = useCallback(async () => {
    const result = await invoke<Recording[]>("load_recordings");
    setRecordings(result.sort((a, b) => b.created_at - a.created_at));
  }, []);

  const saveRecording = useCallback(async (name: string, events: InputEvent[]): Promise<Recording> => {
    const recording = await invoke<Recording>("save_recording", { name, events });
    await loadRecordings();
    return recording;
  }, [loadRecordings]);

  const deleteRecording = useCallback(async (id: string) => {
    await invoke("delete_recording", { id });
    await loadRecordings();
    
    setSelectedRecording((current) => (current?.id === id ? null : current));
  }, [loadRecordings]);

  const updateRecordingName = useCallback(async (id: string, name: string): Promise<Recording> => {
    const recording = await invoke<Recording>("update_recording_name", { id, name });
    await loadRecordings();

    setSelectedRecording((current) => (current?.id === id ? recording : current));

    return recording;
  }, [loadRecordings]);

  const updateRecordingSpeed = useCallback(async (id: string, speed: number): Promise<Recording> => {
    const recording = await invoke<Recording>("update_recording_speed", { id, speed });
    await loadRecordings();

    setSelectedRecording((current) => (current?.id === id ? recording : current));

    return recording;
  }, [loadRecordings]);

  useEffect(() => {
    loadRecordings();
  }, [loadRecordings]);

  return {
    recordings,
    selectedRecording,
    setSelectedRecording,
    saveRecording,
    deleteRecording,
    updateRecordingName,
    updateRecordingSpeed,
    loadRecordings,
  } as const;
};
