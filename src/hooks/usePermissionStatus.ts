import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { invoke, logEvent, measureAsync } from "@/lib/observability";

const isMac = () => typeof navigator !== "undefined" && navigator.userAgent.includes("Mac");

// macOS deep link to System Settings → Privacy & Security → Screen Recording.
const SCREEN_RECORDING_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";
const ACCESSIBILITY_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";

export interface PermissionState {
  screenRecording: boolean | null;
  accessibility: boolean | null;
  needsScreenRecording: boolean;
  needsAccessibility: boolean;
  captureError: string | null;
}

export const usePermissionStatus = () => {
  const [state, setState] = useState<PermissionState>({
    screenRecording: null,
    accessibility: null,
    needsScreenRecording: false,
    needsAccessibility: false,
    captureError: null,
  });

  const recheck = useCallback(async () => {
    if (!isMac()) {
      setState((s) => ({
        ...s,
        screenRecording: true,
        accessibility: true,
        needsScreenRecording: false,
        needsAccessibility: false,
      }));
      return true;
    }
    try {
      const [screenRecording, accessibility] = await Promise.all([
        invoke<boolean>("check_screen_recording_permission"),
        invoke<boolean>("check_accessibility_permission"),
      ]);
      setState((s) => ({
        ...s,
        screenRecording,
        accessibility,
        needsScreenRecording: !screenRecording,
        needsAccessibility: !accessibility,
      }));
      return screenRecording && accessibility;
    } catch (err) {
      logEvent("error", "permissions", "check_permissions_failed", { error: err });
      return false;
    }
  }, []);

  const requestPermissions = useCallback(async () => {
    try {
      await invoke("request_accessibility");
      await invoke("request_screen_recording");
    } catch (err) {
      logEvent("error", "permissions", "request_permissions_failed", { error: err });
    } finally {
      await recheck();
    }
  }, [recheck]);

  const openScreenRecordingSettings = useCallback(async () => {
    if (!isMac()) return;
    try {
      await measureAsync("permissions", "open_screen_recording_settings", () =>
        openUrl(SCREEN_RECORDING_SETTINGS_URL),
      );
    } catch (err) {
      logEvent("error", "permissions", "open_screen_recording_settings_failed", { error: err });
    }
  }, []);

  const openAccessibilitySettings = useCallback(async () => {
    if (!isMac()) return;
    try {
      await measureAsync("permissions", "open_accessibility_settings", () =>
        openUrl(ACCESSIBILITY_SETTINGS_URL),
      );
    } catch (err) {
      logEvent("error", "permissions", "open_accessibility_settings_failed", { error: err });
    }
  }, []);

  const dismissCaptureError = useCallback(() => {
    setState((s) => ({ ...s, captureError: null }));
  }, []);

  const dismissPermissionPrompt = useCallback(() => {
    setState((s) => ({ ...s, needsScreenRecording: false, needsAccessibility: false }));
  }, []);

  useEffect(() => {
    void recheck();
  }, [recheck]);

  useEffect(() => {
    const unlistenPerm = listen<string>("permission-needed", (ev) => {
      if (ev.payload === "screen-recording") {
        setState((s) => ({ ...s, needsScreenRecording: true, screenRecording: false }));
      } else if (ev.payload === "accessibility") {
        setState((s) => ({ ...s, needsAccessibility: true, accessibility: false }));
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
    requestPermissions,
    openSystemSettings: openScreenRecordingSettings,
    openScreenRecordingSettings,
    openAccessibilitySettings,
    dismissCaptureError,
    dismissPermissionPrompt,
  } as const;
};
