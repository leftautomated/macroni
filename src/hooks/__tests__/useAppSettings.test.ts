import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useAppSettings } from "../useAppSettings";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
}));

describe("useAppSettings", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("loads settings on mount", async () => {
    invokeMock.mockResolvedValueOnce({
      capture: { video: true, fps: 30, quality: "med", audio: true },
      perception: { continuous_ocr: false },
    });
    const { result } = renderHook(() => useAppSettings());
    await waitFor(() => expect(result.current.settings).not.toBeNull());
    expect(result.current.settings?.capture.fps).toBe(30);
  });

  it("persists updates via save_settings", async () => {
    invokeMock.mockResolvedValueOnce({
      capture: { video: true, fps: 30, quality: "med", audio: true },
      perception: { continuous_ocr: false },
    });
    invokeMock.mockResolvedValueOnce(undefined);
    const { result } = renderHook(() => useAppSettings());
    await waitFor(() => expect(result.current.settings).not.toBeNull());

    await act(async () => {
      await result.current.update({
        capture: { video: false, fps: 60, quality: "high", audio: false },
        perception: { continuous_ocr: false },
      });
    });

    expect(invokeMock).toHaveBeenCalledWith(
      "save_settings",
      expect.objectContaining({
        settings: {
          capture: { video: false, fps: 60, quality: "high", audio: false },
          perception: { continuous_ocr: false },
        },
        traceId: expect.any(String),
      }),
    );
    expect(result.current.settings?.capture.fps).toBe(60);
  });
});
