import { useState, useEffect } from "react";
import { listen } from "@tauri-apps/api/event";

export const usePlaybackPosition = (
  isPlaying: boolean,
  onComplete?: () => void
) => {
  const [currentPosition, setCurrentPosition] = useState<number | null>(null);

  useEffect(() => {
    if (!isPlaying) {
      setCurrentPosition(null);
      return;
    }

    const unlistenPosition = listen<number>("playback-position", (event) => {
      setCurrentPosition(event.payload);
    });

    const unlistenComplete = listen("playback-complete", () => {
      setCurrentPosition(null);
      onComplete?.();
    });

    const unlistenLoopRestart = listen("playback-loop-restart", () => {
      setCurrentPosition(0);
    });

    return () => {
      unlistenPosition.then((fn) => fn());
      unlistenComplete.then((fn) => fn());
      unlistenLoopRestart.then((fn) => fn());
    };
  }, [isPlaying, onComplete]);

  return currentPosition;
};

