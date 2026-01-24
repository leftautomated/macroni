import { useState, useEffect } from "react";
import { Recording } from "@/types";

export const useRecordingTitle = (recording: Recording | null, isEditing: boolean) => {
  const [titleValue, setTitleValue] = useState(recording?.name || "");
  const [lastRecordingId, setLastRecordingId] = useState(recording?.id || "");

  // Update title value only when switching to a different recording (not when the same recording's name changes)
  useEffect(() => {
    if (recording && recording.id !== lastRecordingId && !isEditing) {
      setTitleValue(recording.name);
      setLastRecordingId(recording.id);
    }
  }, [recording?.id, lastRecordingId, isEditing]);

  return { titleValue, setTitleValue };
};

