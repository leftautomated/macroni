import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke, logEvent } from "@/lib/observability";
import type { MacroDoc } from "@/types";

export type MacroRunState = "idle" | "running";

export interface MacroRunFailure {
  nodeId: string;
  reason: string;
}

interface MacroNodeStartedPayload {
  macroId: string;
  nodeId: string;
  index: number;
}

interface MacroNodeFinishedPayload {
  macroId: string;
  nodeId: string;
  index: number;
}

interface MacroRunFinishedPayload {
  macroId: string;
  ok: boolean;
}

interface MacroRunFailedPayload {
  macroId: string;
  nodeId: string;
  reason: string;
}

export const useMacros = () => {
  const [macros, setMacros] = useState<MacroDoc[]>([]);
  const [runState, setRunState] = useState<MacroRunState>("idle");
  const [liveNodeId, setLiveNodeId] = useState<string | null>(null);
  const [failed, setFailed] = useState<MacroRunFailure | null>(null);

  const load = useCallback(async () => {
    const docs = await invoke<MacroDoc[]>("load_macros");
    setMacros(docs);
  }, []);

  const save = useCallback(
    async (doc: MacroDoc): Promise<MacroDoc> => {
      const resolved = await invoke<MacroDoc>("save_macro", { doc });
      await load();
      return resolved;
    },
    [load],
  );

  const remove = useCallback(
    async (id: string) => {
      await invoke("delete_macro", { id });
      await load();
    },
    [load],
  );

  const run = useCallback(async (id: string) => {
    setRunState("running");
    try {
      await invoke("run_macro", { id });
    } catch (err) {
      // run_macro can reject before any run event fires (macro not found,
      // engine busy, missing asset, store I/O). Clear the optimistic
      // "running" state so the indicator doesn't stick forever.
      setRunState("idle");
      logEvent("error", "macros", "run_failed", { error: err, fields: { id } });
      throw err;
    }
  }, []);

  const stop = useCallback(async () => {
    await invoke("stop_macro");
  }, []);

  // Lets a caller (e.g. selecting/creating a different macro) drop a stale
  // failure banner/highlight instead of it bleeding onto the newly selected
  // macro.
  const clearFailed = useCallback(() => setFailed(null), []);

  useEffect(() => {
    load().catch((err) => {
      logEvent("error", "macros", "load_failed", { error: err });
    });
  }, [load]);

  useEffect(() => {
    const unlistenStarted = listen<MacroNodeStartedPayload>("macro-node-started", (event) => {
      setLiveNodeId(event.payload.nodeId);
      setRunState("running");
      setFailed(null);
    });
    const unlistenFinished = listen<MacroNodeFinishedPayload>("macro-node-finished", () => {
      // No-op: liveNodeId persists until the next node starts.
    });
    const unlistenRunFinished = listen<MacroRunFinishedPayload>("macro-run-finished", () => {
      setRunState("idle");
      setLiveNodeId(null);
    });
    const unlistenRunFailed = listen<MacroRunFailedPayload>("macro-run-failed", (event) => {
      setRunState("idle");
      setLiveNodeId(null);
      setFailed({ nodeId: event.payload.nodeId, reason: event.payload.reason });
    });

    return () => {
      unlistenStarted.then((fn) => fn()).catch(() => {});
      unlistenFinished.then((fn) => fn()).catch(() => {});
      unlistenRunFinished.then((fn) => fn()).catch(() => {});
      unlistenRunFailed.then((fn) => fn()).catch(() => {});
    };
  }, []);

  return {
    macros,
    load,
    save,
    remove,
    run,
    stop,
    runState,
    liveNodeId,
    failed,
    clearFailed,
  } as const;
};
