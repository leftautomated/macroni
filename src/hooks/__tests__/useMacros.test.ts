import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import type { MacroDoc } from "@/types";

type Listener = (event: { payload: unknown }) => void | Promise<void>;

const state = vi.hoisted(() => ({
  listeners: new Map<string, Listener>(),
}));

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/observability", () => ({
  // Mirror the real invoke's default `args = {}` so call-site assertions match
  // regardless of whether the hook passes an explicit args object.
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args ?? {}),
  logEvent: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: Listener) => {
    state.listeners.set(event, handler);
    return () => state.listeners.delete(event);
  }),
}));

import { useMacros } from "../useMacros";

function makeMacro(id: string): MacroDoc {
  return {
    id,
    name: `Macro ${id}`,
    nodes: [],
    edges: [],
    created_at: 1,
  };
}

describe("useMacros", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    state.listeners.clear();
  });

  it("load populates macros from load_macros", async () => {
    const docs = [makeMacro("m1"), makeMacro("m2")];
    invokeMock.mockResolvedValueOnce(docs);

    const { result } = renderHook(() => useMacros());

    await waitFor(() => expect(result.current.macros).toEqual(docs));
    expect(invokeMock).toHaveBeenCalledWith("load_macros", {});
  });

  it("subscribes to the four macro run events on mount", async () => {
    invokeMock.mockResolvedValueOnce([]);
    renderHook(() => useMacros());

    await waitFor(() => {
      expect(state.listeners.has("macro-node-started")).toBe(true);
      expect(state.listeners.has("macro-node-finished")).toBe(true);
      expect(state.listeners.has("macro-run-finished")).toBe(true);
      expect(state.listeners.has("macro-run-failed")).toBe(true);
    });
  });

  it("macro-node-started sets liveNodeId, runState=running, and clears failed", async () => {
    invokeMock.mockResolvedValueOnce([]);
    const { result } = renderHook(() => useMacros());
    await waitFor(() => expect(state.listeners.get("macro-node-started")).toBeDefined());

    // Seed a prior failure to prove it gets cleared.
    await act(async () => {
      await state.listeners.get("macro-run-failed")?.({
        payload: { macroId: "m1", nodeId: "n1", reason: "boom" },
      });
    });
    expect(result.current.failed).toEqual({ nodeId: "n1", reason: "boom" });

    await act(async () => {
      await state.listeners.get("macro-node-started")?.({
        payload: { macroId: "m1", nodeId: "n2", index: 1 },
      });
    });

    expect(result.current.liveNodeId).toBe("n2");
    expect(result.current.runState).toBe("running");
    expect(result.current.failed).toBeNull();
  });

  it("macro-node-finished is a no-op (liveNodeId persists until next start)", async () => {
    invokeMock.mockResolvedValueOnce([]);
    const { result } = renderHook(() => useMacros());
    await waitFor(() => expect(state.listeners.get("macro-node-started")).toBeDefined());

    await act(async () => {
      await state.listeners.get("macro-node-started")?.({
        payload: { macroId: "m1", nodeId: "n2", index: 1 },
      });
    });
    expect(result.current.liveNodeId).toBe("n2");

    await act(async () => {
      await state.listeners.get("macro-node-finished")?.({
        payload: { macroId: "m1", nodeId: "n2", index: 1 },
      });
    });

    expect(result.current.liveNodeId).toBe("n2");
    expect(result.current.runState).toBe("running");
  });

  it("macro-run-finished resets runState to idle and clears liveNodeId", async () => {
    invokeMock.mockResolvedValueOnce([]);
    const { result } = renderHook(() => useMacros());
    await waitFor(() => expect(state.listeners.get("macro-node-started")).toBeDefined());

    await act(async () => {
      await state.listeners.get("macro-node-started")?.({
        payload: { macroId: "m1", nodeId: "n2", index: 1 },
      });
    });
    expect(result.current.runState).toBe("running");

    await act(async () => {
      await state.listeners.get("macro-run-finished")?.({
        payload: { macroId: "m1", ok: true },
      });
    });

    expect(result.current.runState).toBe("idle");
    expect(result.current.liveNodeId).toBeNull();
  });

  it("macro-run-failed sets failed and resets runState to idle, clears liveNodeId", async () => {
    invokeMock.mockResolvedValueOnce([]);
    const { result } = renderHook(() => useMacros());
    await waitFor(() => expect(state.listeners.get("macro-node-started")).toBeDefined());

    await act(async () => {
      await state.listeners.get("macro-node-started")?.({
        payload: { macroId: "m1", nodeId: "n2", index: 1 },
      });
    });

    await act(async () => {
      await state.listeners.get("macro-run-failed")?.({
        payload: { macroId: "m1", nodeId: "n2", reason: "timeout" },
      });
    });

    expect(result.current.failed).toEqual({ nodeId: "n2", reason: "timeout" });
    expect(result.current.runState).toBe("idle");
    expect(result.current.liveNodeId).toBeNull();
  });

  it("save calls save_macro with { doc } and returns the resolved doc, refreshing the list", async () => {
    const original = makeMacro("m1");
    const saved = { ...original, name: "Renamed" };
    invokeMock.mockResolvedValueOnce([]); // initial load
    invokeMock.mockResolvedValueOnce(saved); // save_macro
    invokeMock.mockResolvedValueOnce([saved]); // refresh load

    const { result } = renderHook(() => useMacros());
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("load_macros", {}));

    let returned: MacroDoc | undefined;
    await act(async () => {
      returned = await result.current.save(original);
    });

    expect(invokeMock).toHaveBeenCalledWith("save_macro", { doc: original });
    expect(returned).toEqual(saved);
    // save() refreshes via a load_macros re-fetch (not a local splice).
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "load_macros")).toHaveLength(2);
    await waitFor(() => expect(result.current.macros).toEqual([saved]));
  });

  it("remove calls delete_macro with { id } and refreshes the list", async () => {
    invokeMock.mockResolvedValueOnce([makeMacro("m1")]); // initial load
    invokeMock.mockResolvedValueOnce(undefined); // delete_macro
    invokeMock.mockResolvedValueOnce([]); // refresh load

    const { result } = renderHook(() => useMacros());
    await waitFor(() => expect(result.current.macros).toHaveLength(1));

    await act(async () => {
      await result.current.remove("m1");
    });

    expect(invokeMock).toHaveBeenCalledWith("delete_macro", { id: "m1" });
    // remove() refreshes via a load_macros re-fetch (not a local filter).
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "load_macros")).toHaveLength(2);
    await waitFor(() => expect(result.current.macros).toEqual([]));
  });

  it("run sets runState to running optimistically and calls run_macro with { id }", async () => {
    invokeMock.mockResolvedValueOnce([]); // initial load
    invokeMock.mockResolvedValueOnce(undefined); // run_macro

    const { result } = renderHook(() => useMacros());
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("load_macros", {}));

    await act(async () => {
      await result.current.run("m1");
    });

    expect(result.current.runState).toBe("running");
    expect(invokeMock).toHaveBeenCalledWith("run_macro", { id: "m1" });
  });

  it("run rethrows invoke errors so the caller can toast", async () => {
    invokeMock.mockResolvedValueOnce([]); // initial load
    const failure = new Error("backend exploded");
    invokeMock.mockRejectedValueOnce(failure);

    const { result } = renderHook(() => useMacros());
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("load_macros", {}));

    await expect(result.current.run("m1")).rejects.toThrow("backend exploded");
  });

  it("run resets runState to idle when invoke rejects synchronously (no event fires)", async () => {
    invokeMock.mockResolvedValueOnce([]); // initial load
    // run_macro rejects before any run event is emitted (macro not found,
    // engine busy, missing asset, store I/O). The optimistic "running" state
    // must not stick.
    invokeMock.mockRejectedValueOnce(new Error("engine busy"));

    const { result } = renderHook(() => useMacros());
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("load_macros", {}));

    await act(async () => {
      await expect(result.current.run("m1")).rejects.toThrow("engine busy");
    });

    expect(result.current.runState).toBe("idle");
  });

  it("stop calls stop_macro", async () => {
    invokeMock.mockResolvedValueOnce([]); // initial load
    invokeMock.mockResolvedValueOnce(undefined); // stop_macro

    const { result } = renderHook(() => useMacros());
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("load_macros", {}));

    await act(async () => {
      await result.current.stop();
    });

    expect(invokeMock).toHaveBeenCalledWith("stop_macro", {});
  });

  it("unlistens from all four events on unmount", async () => {
    invokeMock.mockResolvedValueOnce([]);
    const { unmount } = renderHook(() => useMacros());
    await waitFor(() => expect(state.listeners.size).toBe(4));

    unmount();

    await waitFor(() => expect(state.listeners.size).toBe(0));
  });
});
