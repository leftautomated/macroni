import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  check: vi.fn(),
  getVersion: vi.fn(),
  invoke: vi.fn(),
  logEvent: vi.fn(),
  relaunch: vi.fn(),
}));

vi.mock("@tauri-apps/api/app", () => ({ getVersion: mocks.getVersion }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: mocks.relaunch }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: mocks.check }));
vi.mock("@/lib/observability", () => ({
  invoke: mocks.invoke,
  logEvent: mocks.logEvent,
  stringifyError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

import { useAppUpdater } from "@/hooks/useAppUpdater";

function makeUpdate() {
  return {
    body: "What’s new",
    close: vi.fn().mockResolvedValue(undefined),
    currentVersion: "0.1.7",
    downloadAndInstall: vi.fn().mockImplementation(async (onEvent) => {
      onEvent({ event: "Started", data: { contentLength: 100 } });
      onEvent({ event: "Progress", data: { chunkLength: 50 } });
      onEvent({ event: "Finished" });
    }),
    version: "0.1.8",
  };
}

describe("useAppUpdater", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getVersion.mockResolvedValue("0.1.7");
    mocks.check.mockResolvedValue(null);
    mocks.invoke.mockResolvedValue({ isPlaying: false, isRecording: false });
    mocks.relaunch.mockResolvedValue(undefined);
  });

  it("checks automatically and reports when the app is current", async () => {
    const { result } = renderHook(() => useAppUpdater());

    await waitFor(() => expect(result.current.status).toBe("up-to-date"));
    expect(result.current.currentVersion).toBe("0.1.7");
    expect(mocks.check).toHaveBeenCalledWith({ timeout: 15_000 });
  });

  it("downloads, installs, and relaunches for an available update", async () => {
    const update = makeUpdate();
    mocks.check.mockResolvedValue(update);
    const { result } = renderHook(() => useAppUpdater());
    await waitFor(() => expect(result.current.status).toBe("available"));

    await act(async () => result.current.installUpdate());

    expect(update.downloadAndInstall).toHaveBeenCalledOnce();
    expect(mocks.relaunch).toHaveBeenCalledOnce();
    expect(result.current.status).toBe("installing");
    expect(result.current.progress).toBe(100);
  });

  it("refuses to install while a recording is active", async () => {
    const update = makeUpdate();
    mocks.check.mockResolvedValue(update);
    mocks.invoke.mockResolvedValue({ isPlaying: false, isRecording: true });
    const { result } = renderHook(() => useAppUpdater());
    await waitFor(() => expect(result.current.status).toBe("available"));

    await act(async () => result.current.installUpdate());

    expect(update.downloadAndInstall).not.toHaveBeenCalled();
    expect(mocks.relaunch).not.toHaveBeenCalled();
    expect(result.current.status).toBe("error");
    expect(result.current.error).toMatch(/stop recording and playback/i);
  });
});
