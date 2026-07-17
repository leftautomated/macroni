import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useState } from "react";
import { invoke, logEvent } from "@/lib/observability";

export type ClickerButton = "left" | "right" | "middle";
export type ClickerPeriod = "second" | "minute" | "hour";
export type ClickerStatus = "idle" | "arming" | "running" | "stopping";

export interface ClickerConfig {
  button: ClickerButton;
  clicksPerPeriod: number;
  period: ClickerPeriod;
}

interface ClickerStoppedPayload {
  error?: string | null;
}

const DEFAULT_CONFIG: ClickerConfig = {
  button: "left",
  clicksPerPeriod: 10,
  period: "second",
};

export function useClicker() {
  const [config, setConfig] = useState<ClickerConfig>(DEFAULT_CONFIG);
  const [status, setStatus] = useState<ClickerStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const unlistenStarted = listen("clicker-started", () => {
      setStatus("running");
    });
    const unlistenStopped = listen<ClickerStoppedPayload>("clicker-stopped", (event) => {
      setStatus("idle");
      setError(event.payload?.error ?? null);
    });
    return () => {
      unlistenStarted.then((unlisten) => unlisten());
      unlistenStopped.then((unlisten) => unlisten());
    };
  }, []);

  const start = useCallback(async () => {
    setError(null);
    setStatus("arming");
    try {
      await invoke(
        "start_clicker",
        { ...config },
        {
          area: "clicker",
          fields: {
            button: config.button,
            clicksPerPeriod: config.clicksPerPeriod,
            period: config.period,
          },
        },
      );
    } catch (startError) {
      setStatus("idle");
      setError(startError instanceof Error ? startError.message : String(startError));
      logEvent("error", "clicker", "start_failed", { error: startError });
    }
  }, [config]);

  const stop = useCallback(async () => {
    setStatus("stopping");
    try {
      await invoke("stop_clicker", {}, { area: "clicker" });
    } catch (stopError) {
      setStatus("running");
      setError(stopError instanceof Error ? stopError.message : String(stopError));
      logEvent("error", "clicker", "stop_failed", { error: stopError });
    }
  }, []);

  return {
    config,
    error,
    setConfig,
    start,
    status,
    stop,
  };
}
