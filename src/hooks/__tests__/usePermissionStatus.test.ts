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
    invokeMock.mockResolvedValueOnce(true);
    const { result } = renderHook(() => usePermissionStatus());
    await waitFor(() => expect(result.current.state.screenRecording).toBe(true));
    expect(invokeMock).toHaveBeenCalledWith("check_screen_recording_permission", undefined);
  });

  it("sets needsScreenRecording when permission-needed event arrives", async () => {
    invokeMock.mockResolvedValueOnce(false);
    const { result } = renderHook(() => usePermissionStatus());
    await waitFor(() => expect(result.current.state.screenRecording).toBe(false));

    await waitFor(() => expect(listeners.get("permission-needed")).toBeDefined());
    act(() => {
      listeners.get("permission-needed")?.({ payload: "screen-recording" });
    });

    expect(result.current.state.needsScreenRecording).toBe(true);
  });

  it("captures capture-failed payload", async () => {
    invokeMock.mockResolvedValueOnce(true);
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
    invokeMock.mockResolvedValueOnce(false);
    const { result } = renderHook(() => usePermissionStatus());
    await waitFor(() => expect(result.current.state.screenRecording).toBe(false));

    await waitFor(() => expect(listeners.get("permission-needed")).toBeDefined());
    act(() => {
      listeners.get("permission-needed")?.({ payload: "screen-recording" });
    });
    expect(result.current.state.needsScreenRecording).toBe(true);

    invokeMock.mockResolvedValueOnce(true);
    await act(async () => {
      await result.current.recheck();
    });
    expect(result.current.state.screenRecording).toBe(true);
    expect(result.current.state.needsScreenRecording).toBe(false);
  });

  it("openSystemSettings opens the macOS Screen Recording pane", async () => {
    invokeMock.mockResolvedValueOnce(true);
    const { result } = renderHook(() => usePermissionStatus());
    await waitFor(() => expect(result.current.state.screenRecording).toBe(true));

    await act(async () => {
      await result.current.openSystemSettings();
    });
    expect(openUrlMock).toHaveBeenCalledWith(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
    );
  });
});
