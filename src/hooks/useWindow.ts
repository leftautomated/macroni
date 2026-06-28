import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useCallback } from "react";
import { invoke, logEvent } from "@/lib/observability";

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
      logEvent("error", "window", "resize_failed", { error, fields: { width, height } });
    }
  }, []);

  return { resizeWindow };
};
