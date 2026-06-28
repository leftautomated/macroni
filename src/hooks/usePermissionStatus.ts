import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { invoke, logEvent, measureAsync } from "@/lib/observability";

const isMac = () => typeof navigator !== "undefined" && navigator.userAgent.includes("Mac");

// macOS deep link to System Settings → Privacy & Security → Screen Recording.
const SCREEN_RECORDING_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_ScreenCapture";
const ACCESSIBILITY_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Accessibility";

type PermissionPanel = "accessibility" | "screen-recording";

export interface PermissionAssistantSourceRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

export interface PermissionState {
  screenRecording: boolean | null;
  accessibility: boolean | null;
  needsScreenRecording: boolean;
  needsAccessibility: boolean;
  captureError: string | null;
}

export const usePermissionStatus = () => {
  const assistantVisible = useRef(false);
  const permissionPollInFlight = useRef(false);
  const [assistantActive, setAssistantActive] = useState(false);
  const [activeAssistantPanel, setActiveAssistantPanel] = useState<PermissionPanel | null>(null);
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

  const dismissPermissionAssistant = useCallback(async () => {
    if (!isMac()) return;
    try {
      await invoke("dismiss_permission_assistant");
    } catch (err) {
      logEvent("error", "permissions", "dismiss_permission_assistant_failed", { error: err });
    } finally {
      assistantVisible.current = false;
      setAssistantActive(false);
      setActiveAssistantPanel(null);
    }
  }, []);

  const presentPermissionAssistant = useCallback(
    async (panel: PermissionPanel, sourceRect?: PermissionAssistantSourceRect) => {
      if (!isMac()) return;
      const url =
        panel === "accessibility" ? ACCESSIBILITY_SETTINGS_URL : SCREEN_RECORDING_SETTINGS_URL;
      try {
        setActiveAssistantPanel(panel);
        await measureAsync("permissions", `open_${panel}_settings`, () => openUrl(url));
        let lastError: unknown = null;
        for (let attempt = 0; attempt < 18; attempt += 1) {
          try {
            const presented = await invoke<boolean>("present_permission_assistant", {
              panel,
              sourceRect,
            });
            if (presented) {
              assistantVisible.current = true;
              setAssistantActive(true);
              const complete = await recheck();
              if (complete) {
                await dismissPermissionAssistant();
              }
              return;
            }
          } catch (err) {
            lastError = err;
          }
          await sleep(90);
        }
        throw lastError ?? new Error("System Settings window was not ready for the assistant.");
      } catch (err) {
        logEvent("error", "permissions", "present_permission_assistant_failed", {
          error: err,
          fields: { panel },
        });
        await dismissPermissionAssistant();
      }
    },
    [dismissPermissionAssistant, recheck],
  );

  useEffect(() => {
    if (!assistantActive || !isMac()) return;

    const interval = window.setInterval(() => {
      void (async () => {
        try {
          const stillVisible = await invoke<boolean>("refresh_permission_assistant");
          if (!stillVisible) {
            assistantVisible.current = false;
            setAssistantActive(false);
            setActiveAssistantPanel(null);
          }
        } catch (err) {
          logEvent("error", "permissions", "refresh_permission_assistant_failed", { error: err });
          assistantVisible.current = false;
          setAssistantActive(false);
          setActiveAssistantPanel(null);
        }
      })();
    }, 33);

    return () => window.clearInterval(interval);
  }, [assistantActive]);

  useEffect(() => {
    if (!isMac()) return;

    const shouldPoll =
      assistantActive ||
      state.needsAccessibility ||
      state.needsScreenRecording ||
      state.accessibility === false ||
      state.screenRecording === false;
    if (!shouldPoll) return;

    let cancelled = false;
    const intervalMs = assistantActive ? 500 : 1500;
    const poll = async () => {
      if (permissionPollInFlight.current) return;
      permissionPollInFlight.current = true;
      try {
        const complete = await recheck();
        if (!cancelled && complete && (assistantVisible.current || assistantActive)) {
          await dismissPermissionAssistant();
        }
      } finally {
        permissionPollInFlight.current = false;
      }
    };

    const interval = window.setInterval(() => {
      void poll();
    }, intervalMs);
    if (assistantActive) {
      void poll();
    }

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [
    assistantActive,
    dismissPermissionAssistant,
    recheck,
    state.accessibility,
    state.needsAccessibility,
    state.needsScreenRecording,
    state.screenRecording,
  ]);

  const requestPermissions = useCallback(async () => {
    const missingPanel: PermissionPanel | null =
      state.needsAccessibility || state.accessibility === false
        ? "accessibility"
        : state.needsScreenRecording || state.screenRecording === false
          ? "screen-recording"
          : null;

    try {
      await invoke("request_accessibility");
      await invoke("request_screen_recording");
    } catch (err) {
      logEvent("error", "permissions", "request_permissions_failed", { error: err });
    } finally {
      const complete = await recheck();
      if (complete) {
        await dismissPermissionAssistant();
      } else if (missingPanel) {
        await presentPermissionAssistant(missingPanel);
      }
    }
  }, [
    dismissPermissionAssistant,
    presentPermissionAssistant,
    recheck,
    state.accessibility,
    state.needsAccessibility,
    state.needsScreenRecording,
    state.screenRecording,
  ]);

  const openScreenRecordingSettings = useCallback(
    async (sourceRect?: PermissionAssistantSourceRect) => {
      await presentPermissionAssistant("screen-recording", sourceRect);
    },
    [presentPermissionAssistant],
  );

  const openAccessibilitySettings = useCallback(
    async (sourceRect?: PermissionAssistantSourceRect) => {
      await presentPermissionAssistant("accessibility", sourceRect);
    },
    [presentPermissionAssistant],
  );

  const dismissCaptureError = useCallback(() => {
    setState((s) => ({ ...s, captureError: null }));
  }, []);

  const dismissPermissionPrompt = useCallback(() => {
    setState((s) => ({ ...s, needsScreenRecording: false, needsAccessibility: false }));
    void dismissPermissionAssistant();
  }, [dismissPermissionAssistant]);

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
    activeAssistantPanel,
    dismissCaptureError,
    dismissPermissionPrompt,
  } as const;
};
