import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { invoke, logEvent, measureAsync } from "@/lib/observability";

const isMac = () => typeof navigator !== "undefined" && navigator.userAgent.includes("Mac");

// macOS deep link to System Settings → Privacy & Security → Screen Recording.
const SCREEN_RECORDING_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";

export interface PermissionState {
  screenRecording: boolean | null;
  needsScreenRecording: boolean;
  captureError: string | null;
}

export const usePermissionStatus = () => {
  const [state, setState] = useState<PermissionState>({
    screenRecording: null,
    needsScreenRecording: false,
    captureError: null,
  });

  const recheck = useCallback(async () => {
    if (!isMac()) {
      setState((s) => ({ ...s, screenRecording: true, needsScreenRecording: false }));
      return true;
    }
    try {
      const granted = await invoke<boolean>("check_screen_recording_permission");
      setState((s) => ({
        ...s,
        screenRecording: granted,
        needsScreenRecording: granted ? false : s.needsScreenRecording,
      }));
      return granted;
    } catch (err) {
      logEvent("error", "permissions", "check_screen_recording_failed", { error: err });
      return false;
    }
  }, []);

  const requestScreenRecording = useCallback(async () => {
    try {
      await invoke("request_screen_recording");
    } catch (err) {
      logEvent("error", "permissions", "request_screen_recording_failed", { error: err });
    }
  }, []);

  const openSystemSettings = useCallback(async () => {
    if (!isMac()) return;
    try {
      await measureAsync("permissions", "open_system_settings", () =>
        openUrl(SCREEN_RECORDING_SETTINGS_URL),
      );
    } catch (err) {
      logEvent("error", "permissions", "open_system_settings_failed", { error: err });
    }
  }, []);

  const dismissCaptureError = useCallback(() => {
    setState((s) => ({ ...s, captureError: null }));
  }, []);

  const dismissPermissionPrompt = useCallback(() => {
    setState((s) => ({ ...s, needsScreenRecording: false }));
  }, []);

  useEffect(() => {
    void recheck();
  }, [recheck]);

  useEffect(() => {
    const unlistenPerm = listen<string>("permission-needed", (ev) => {
      if (ev.payload === "screen-recording") {
        setState((s) => ({ ...s, needsScreenRecording: true, screenRecording: false }));
      }
    });
    const unlistenFail = listen<string>("capture-failed", (ev) => {
      setState((s) => ({ ...s, captureError: ev.payload }));
    });
    return () => {
      unlistenPerm.then((fn) => fn());
      unlistenFail.then((fn) => fn());
    };
  }, []);

  return {
    state,
    recheck,
    requestScreenRecording,
    openSystemSettings,
    dismissCaptureError,
    dismissPermissionPrompt,
  } as const;
};
