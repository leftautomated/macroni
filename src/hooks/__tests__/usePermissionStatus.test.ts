import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

const invokeMock = vi.fn();
const openUrlMock = vi.fn();
const listeners = new Map<string, (ev: { payload: string }) => void>();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, cb: (ev: { payload: string }) => void) => {
    listeners.set(event, cb);
    return Promise.resolve(() => listeners.delete(event));
  },
}));
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: (url: string) => openUrlMock(url),
}));

// Force the macOS branch regardless of host platform.
Object.defineProperty(navigator, "userAgent", {
  value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
  configurable: true,
});

import { usePermissionStatus } from "../usePermissionStatus";

describe("usePermissionStatus", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    openUrlMock.mockReset();
    listeners.clear();
  });

  it("loads screen recording status on mount", async () => {
    invokeMock.mockResolvedValueOnce(true).mockResolvedValueOnce(true);
    const { result } = renderHook(() => usePermissionStatus());
    await waitFor(() => expect(result.current.state.screenRecording).toBe(true));
    expect(result.current.state.accessibility).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith(
      "check_screen_recording_permission",
      expect.objectContaining({ traceId: expect.any(String) }),
    );
    expect(invokeMock).toHaveBeenCalledWith(
      "check_accessibility_permission",
      expect.objectContaining({ traceId: expect.any(String) }),
    );
  });

  it("sets needsScreenRecording when permission-needed event arrives", async () => {
    invokeMock.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const { result } = renderHook(() => usePermissionStatus());
    await waitFor(() => expect(result.current.state.screenRecording).toBe(false));

    await waitFor(() => expect(listeners.get("permission-needed")).toBeDefined());
    act(() => {
      listeners.get("permission-needed")?.({ payload: "screen-recording" });
    });

    expect(result.current.state.needsScreenRecording).toBe(true);
  });

  it("captures capture-failed payload", async () => {
    invokeMock.mockResolvedValueOnce(true).mockResolvedValueOnce(true);
    const { result } = renderHook(() => usePermissionStatus());
    await waitFor(() => expect(listeners.get("capture-failed")).toBeDefined());

    act(() => {
      listeners.get("capture-failed")?.({ payload: "encoder exploded" });
    });
    expect(result.current.state.captureError).toBe("encoder exploded");

    act(() => {
      result.current.dismissCaptureError();
    });
    expect(result.current.state.captureError).toBeNull();
  });

  it("recheck clears needsScreenRecording when permission is granted", async () => {
    invokeMock.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const { result } = renderHook(() => usePermissionStatus());
    await waitFor(() => expect(result.current.state.screenRecording).toBe(false));

    await waitFor(() => expect(listeners.get("permission-needed")).toBeDefined());
    act(() => {
      listeners.get("permission-needed")?.({ payload: "screen-recording" });
    });
    expect(result.current.state.needsScreenRecording).toBe(true);

    invokeMock.mockResolvedValueOnce(true).mockResolvedValueOnce(true);
    await act(async () => {
      await result.current.recheck();
    });
    expect(result.current.state.screenRecording).toBe(true);
    expect(result.current.state.needsScreenRecording).toBe(false);
  });

  it("openSystemSettings opens the macOS Screen Recording pane", async () => {
    invokeMock
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true);
    const { result } = renderHook(() => usePermissionStatus());
    await waitFor(() => expect(result.current.state.screenRecording).toBe(true));

    await act(async () => {
      await result.current.openSystemSettings();
    });
    expect(openUrlMock).toHaveBeenCalledWith(
      "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_ScreenCapture",
    );
    expect(invokeMock).toHaveBeenCalledWith(
      "present_permission_assistant",
      expect.objectContaining({
        panel: "screen-recording",
        traceId: expect.any(String),
      }),
    );
  });

  it("openAccessibilitySettings opens the macOS Accessibility pane", async () => {
    invokeMock
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true);
    const { result } = renderHook(() => usePermissionStatus());
    await waitFor(() => expect(result.current.state.accessibility).toBe(true));

    await act(async () => {
      await result.current.openAccessibilitySettings();
    });
    expect(openUrlMock).toHaveBeenCalledWith(
      "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Accessibility",
    );
    expect(invokeMock).toHaveBeenCalledWith(
      "present_permission_assistant",
      expect.objectContaining({
        panel: "accessibility",
        traceId: expect.any(String),
      }),
    );
  });

  it("requestPermissions asks for accessibility and screen recording prompts", async () => {
    invokeMock
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true);
    const { result } = renderHook(() => usePermissionStatus());
    await waitFor(() => expect(result.current.state.accessibility).toBe(false));

    await act(async () => {
      await result.current.requestPermissions();
    });

    expect(invokeMock).toHaveBeenCalledWith(
      "request_accessibility",
      expect.objectContaining({ traceId: expect.any(String) }),
    );
    expect(invokeMock).toHaveBeenCalledWith(
      "request_screen_recording",
      expect.objectContaining({ traceId: expect.any(String) }),
    );
    expect(result.current.state.accessibility).toBe(true);
    expect(result.current.state.screenRecording).toBe(true);
  });

  it("requestPermissions opens the assistant when permissions remain missing", async () => {
    invokeMock
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const { result } = renderHook(() => usePermissionStatus());
    await waitFor(() => expect(result.current.state.screenRecording).toBe(false));

    await act(async () => {
      await result.current.requestPermissions();
    });

    expect(openUrlMock).toHaveBeenCalledWith(
      "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_ScreenCapture",
    );
    expect(invokeMock).toHaveBeenCalledWith(
      "present_permission_assistant",
      expect.objectContaining({
        panel: "screen-recording",
        traceId: expect.any(String),
      }),
    );
  });

  it("retries the assistant until System Settings is ready", async () => {
    invokeMock
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true);
    const { result } = renderHook(() => usePermissionStatus());
    await waitFor(() => expect(result.current.state.accessibility).toBe(true));

    await act(async () => {
      await result.current.openAccessibilitySettings();
    });

    expect(
      invokeMock.mock.calls.filter(([cmd]) => cmd === "present_permission_assistant"),
    ).toHaveLength(2);
  });

  it("passes a source rect to the native assistant", async () => {
    invokeMock
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const { result } = renderHook(() => usePermissionStatus());
    await waitFor(() => expect(result.current.state.screenRecording).toBe(false));

    await act(async () => {
      await result.current.openSystemSettings({ x: 10, y: 20, width: 300, height: 80 });
    });

    expect(invokeMock).toHaveBeenCalledWith(
      "present_permission_assistant",
      expect.objectContaining({
        panel: "screen-recording",
        sourceRect: { x: 10, y: 20, width: 300, height: 80 },
        traceId: expect.any(String),
      }),
    );
  });

  it("reveals the previous permission row while switching assistants", async () => {
    let presentCalls = 0;
    let resolveSecondPresent: ((value: boolean) => void) | undefined;
    invokeMock.mockImplementation((cmd: string) => {
      if (
        cmd === "check_screen_recording_permission" ||
        cmd === "check_accessibility_permission"
      ) {
        return Promise.resolve(false);
      }
      if (cmd === "present_permission_assistant") {
        presentCalls += 1;
        if (presentCalls === 1) {
          return Promise.resolve(true);
        }
        return new Promise<boolean>((resolve) => {
          resolveSecondPresent = resolve;
        });
      }
      if (cmd === "refresh_permission_assistant") {
        return Promise.resolve(true);
      }
      return Promise.resolve(undefined);
    });

    const { result } = renderHook(() => usePermissionStatus());
    await waitFor(() => expect(result.current.state.accessibility).toBe(false));

    await act(async () => {
      await result.current.openAccessibilitySettings();
    });
    expect(result.current.activeAssistantPanel).toBe("accessibility");

    let switchPromise: Promise<void> | undefined;
    act(() => {
      switchPromise = result.current.openSystemSettings({ x: 10, y: 20, width: 300, height: 80 });
    });

    await waitFor(() => expect(result.current.activeAssistantPanel).toBeNull());
    expect(resolveSecondPresent).toBeDefined();

    await act(async () => {
      resolveSecondPresent?.(true);
      await switchPromise;
    });
    expect(result.current.activeAssistantPanel).toBe("screen-recording");
  });

  it("polls while the assistant is open and updates when permissions are granted", async () => {
    let screenRecordingGranted = false;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "check_screen_recording_permission") {
        return Promise.resolve(screenRecordingGranted);
      }
      if (cmd === "check_accessibility_permission") {
        return Promise.resolve(true);
      }
      if (cmd === "present_permission_assistant" || cmd === "refresh_permission_assistant") {
        return Promise.resolve(true);
      }
      if (cmd === "dismiss_permission_assistant") {
        return Promise.resolve(undefined);
      }
      return Promise.resolve(undefined);
    });

    const { result } = renderHook(() => usePermissionStatus());
    await waitFor(() => expect(result.current.state.screenRecording).toBe(false));

    await act(async () => {
      await result.current.openSystemSettings();
    });
    screenRecordingGranted = true;

    await waitFor(() => expect(result.current.state.screenRecording).toBe(true), {
      timeout: 1500,
    });
    expect(result.current.state.needsScreenRecording).toBe(false);
    expect(invokeMock).toHaveBeenCalledWith(
      "dismiss_permission_assistant",
      expect.objectContaining({ traceId: expect.any(String) }),
    );
  });
});
