import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
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

function currentStatus(ref: { readonly current: ClickerStatus }): ClickerStatus {
  return ref.current;
}

export function useClicker() {
  const [config, setConfig] = useState<ClickerConfig>(DEFAULT_CONFIG);
  const [status, setStatus] = useState<ClickerStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const statusRef = useRef<ClickerStatus>("idle");

  const transitionTo = useCallback((next: ClickerStatus) => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  useEffect(() => {
    const unlistenStarted = listen("clicker-started", () => {
      if (statusRef.current === "arming") transitionTo("running");
    });
    const unlistenStopped = listen<ClickerStoppedPayload>("clicker-stopped", (event) => {
      transitionTo("idle");
      setError(event.payload?.error ?? null);
    });
    return () => {
      unlistenStarted.then((unlisten) => unlisten());
      unlistenStopped.then((unlisten) => unlisten());
    };
  }, [transitionTo]);

  const start = useCallback(async () => {
    if (statusRef.current !== "idle") return;
    setError(null);
    transitionTo("arming");
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
      if (currentStatus(statusRef) === "arming") transitionTo("idle");
      setError(startError instanceof Error ? startError.message : String(startError));
      logEvent("error", "clicker", "start_failed", { error: startError });
    }
  }, [config, transitionTo]);

  const stop = useCallback(async () => {
    const previous = statusRef.current;
    if (previous !== "arming" && previous !== "running") return;
    transitionTo("stopping");
    try {
      await invoke("stop_clicker", {}, { area: "clicker" });
    } catch (stopError) {
      if (currentStatus(statusRef) === "stopping") transitionTo(previous);
      setError(stopError instanceof Error ? stopError.message : String(stopError));
      logEvent("error", "clicker", "stop_failed", { error: stopError });
    }
  }, [transitionTo]);

  return {
    config,
    error,
    setConfig,
    start,
    status,
    stop,
  };
}
