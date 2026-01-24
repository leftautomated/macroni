import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useCallback } from "react";

export const useWindowResize = () => {
  const resizeWindow = useCallback(async (width: number, height: number) => {
    try {
      const window = getCurrentWebviewWindow();
      await invoke("set_window_size", {
        window,
        width,
        height,
      });
    } catch (error) {
      console.error("Failed to resize window:", error);
    }
  }, []);

  return { resizeWindow };
};

