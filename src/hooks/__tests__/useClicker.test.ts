import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  type Listener = (event: { payload?: { error?: string | null } }) => void;
  return {
    invoke: vi.fn(),
    listeners: new Map<string, Listener>(),
    logEvent: vi.fn(),
  };
});

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, listener: (event: { payload?: unknown }) => void) => {
    mocks.listeners.set(event, listener);
    return () => mocks.listeners.delete(event);
  }),
}));

vi.mock("@/lib/observability", () => ({
  invoke: mocks.invoke,
  logEvent: mocks.logEvent,
}));

import { useClicker } from "@/hooks/useClicker";

describe("useClicker", () => {
  beforeEach(() => {
    mocks.invoke.mockReset().mockResolvedValue(undefined);
    mocks.listeners.clear();
    mocks.logEvent.mockReset();
  });

  it("coalesces rapid duplicate start requests before React rerenders", async () => {
    const { result } = renderHook(() => useClicker());

    await act(async () => {
      await Promise.all([result.current.start(), result.current.start()]);
    });

    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenCalledWith(
      "start_clicker",
      expect.anything(),
      expect.anything(),
    );
    expect(result.current.status).toBe("arming");
  });

  it("ignores restart and duplicate stop requests while a stop is settling", async () => {
    const { result } = renderHook(() => useClicker());
    await waitFor(() => expect(mocks.listeners.has("clicker-started")).toBe(true));

    await act(async () => {
      await result.current.start();
      mocks.listeners.get("clicker-started")?.({});
    });
    mocks.invoke.mockClear();

    await act(async () => {
      await Promise.all([result.current.stop(), result.current.stop(), result.current.start()]);
    });

    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenCalledWith("stop_clicker", {}, expect.anything());
    expect(result.current.status).toBe("stopping");
  });

  it("keeps Stop latched while the final injected click drains", async () => {
    const { result } = renderHook(() => useClicker());
    await waitFor(() => expect(mocks.listeners.has("clicker-stopped")).toBe(true));

    await act(async () => {
      await result.current.start();
      mocks.listeners.get("clicker-started")?.({});
      await result.current.stop();
    });
    mocks.invoke.mockClear();
    vi.useFakeTimers();

    try {
      act(() => {
        mocks.listeners.get("clicker-stopped")?.({ payload: {} });
      });
      expect(result.current.status).toBe("stopping");

      await act(async () => {
        await result.current.start();
      });
      expect(mocks.invoke).not.toHaveBeenCalled();
      expect(mocks.logEvent).toHaveBeenCalledWith("warn", "clicker", "start_ignored", {
        fields: { status: "stopping" },
      });

      act(() => vi.advanceTimersByTime(350));
      expect(result.current.status).toBe("idle");
    } finally {
      vi.useRealTimers();
    }
  });
});
