import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { UI_CONFIG } from "@/config";

export const usePlaybackStatus = (
  isPlaying: boolean,
  onStatusChange: (isPlaying: boolean) => void
) => {
  useEffect(() => {
    if (!isPlaying) return;
    
    const interval = setInterval(async () => {
      try {
        const playing = await invoke<boolean>("is_playing");
        if (!playing) {
          onStatusChange(false);
        }
      } catch (error) {
        console.error("Failed to check playback status:", error);
      }
    }, UI_CONFIG.PLAYBACK_STATUS_POLL_MS);
    
    return () => clearInterval(interval);
  }, [isPlaying, onStatusChange]);
};

