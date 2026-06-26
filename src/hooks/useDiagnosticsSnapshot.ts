import { useCallback, useState } from "react";
import type { DiagnosticsSnapshot } from "@/types";
import { invoke, logEvent, stringifyError } from "@/lib/observability";

export const useDiagnosticsSnapshot = () => {
  const [snapshot, setSnapshot] = useState<DiagnosticsSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const next = await invoke<DiagnosticsSnapshot>(
        "get_diagnostics_snapshot",
        {},
        {
          area: "diagnostics",
          fields: { source: "settings" },
          slowMs: 500,
        },
      );
      setSnapshot(next);
      return next;
    } catch (err) {
      const message = stringifyError(err);
      setError(message);
      logEvent("error", "diagnostics", "snapshot_failed", { error: err });
      return null;
    } finally {
      setIsLoading(false);
    }
  }, []);

  return { error, isLoading, refresh, snapshot } as const;
};
