import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { attachConsole, debug, error, info, trace, warn } from "@tauri-apps/plugin-log";

type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

type Primitive = string | number | boolean | null | undefined;

type FieldValue = Primitive | FieldValue[] | { [key: string]: FieldValue };

type Fields = Record<string, FieldValue>;

interface LogEventOptions {
  message?: string;
  error?: unknown;
  fields?: Fields;
  traceId?: string;
}

interface InvokeOptions {
  area?: string;
  fields?: Fields;
  slowMs?: number;
}

const DEFAULT_SLOW_MS = 1_000;
const MEASURE_WARN_MS = 50;

const sessionId = createTraceId("session");

let initialized = false;

export function initObservability(windowLabel: string) {
  if (initialized) return;
  initialized = true;

  if (import.meta.env.DEV) {
    void attachConsole().catch(() => {
      // Dev-only console mirroring is optional.
    });
  }

  window.addEventListener("error", (event) => {
    logEvent("error", "frontend", "window.error", {
      message: event.message,
      error: event.error,
      fields: {
        filename: event.filename,
        line: event.lineno,
        column: event.colno,
        windowLabel,
      },
    });
  });

  window.addEventListener("unhandledrejection", (event) => {
    logEvent("error", "frontend", "promise.unhandled_rejection", {
      error: event.reason,
      fields: { windowLabel },
    });
  });

  observePerformance(windowLabel);
  logEvent("info", "frontend", "webview.ready", { fields: { windowLabel } });
}

export async function invoke<T>(
  command: string,
  args: Record<string, unknown> = {},
  options: InvokeOptions = {},
): Promise<T> {
  const traceId = createTraceId(command);
  const area = options.area ?? "tauri.command";
  const slowMs = options.slowMs ?? DEFAULT_SLOW_MS;
  const startedAt = performance.now();
  const markBase = `macroni:${command}:${traceId}`;
  const startMark = `${markBase}:start`;
  const endMark = `${markBase}:end`;

  performance.mark(startMark);
  const slowTimer = window.setTimeout(() => {
    logEvent("warn", area, "pending", {
      traceId,
      fields: {
        command,
        elapsedMs: Math.round(performance.now() - startedAt),
        ...options.fields,
      },
    });
  }, slowMs);

  try {
    const result = await tauriInvoke<T>(command, { ...args, traceId });
    return result;
  } catch (err) {
    logEvent("error", area, "error", {
      traceId,
      error: err,
      fields: { command, ...options.fields },
    });
    throw err;
  } finally {
    window.clearTimeout(slowTimer);
    performance.mark(endMark);
    const durationMs = performance.now() - startedAt;
    const level: LogLevel = durationMs >= slowMs ? "warn" : "info";
    logEvent(level, area, durationMs >= slowMs ? "slow" : "finish", {
      traceId,
      fields: {
        command,
        durationMs: roundMs(durationMs),
        ...options.fields,
      },
    });
    try {
      performance.measure(`macroni:${command}`, startMark, endMark);
    } finally {
      performance.clearMarks(startMark);
      performance.clearMarks(endMark);
    }
  }
}

export async function measureAsync<T>(
  area: string,
  name: string,
  work: () => Promise<T>,
  fields: Fields = {},
): Promise<T> {
  const traceId = createTraceId(name);
  const startedAt = performance.now();
  try {
    return await work();
  } catch (err) {
    logEvent("error", area, "error", { traceId, error: err, fields: { name, ...fields } });
    throw err;
  } finally {
    const durationMs = performance.now() - startedAt;
    logEvent(durationMs >= MEASURE_WARN_MS ? "warn" : "info", area, "measure", {
      traceId,
      fields: { name, durationMs: roundMs(durationMs), ...fields },
    });
  }
}

export function logEvent(
  level: LogLevel,
  area: string,
  name: string,
  options: LogEventOptions = {},
) {
  const payload = {
    area,
    name,
    message: options.message,
    error: options.error ? stringifyError(options.error) : undefined,
    traceId: options.traceId,
    sessionId,
    timestampMs: Date.now(),
    fields: options.fields,
  };

  const message = stableStringify(payload);
  const keyValues = toKeyValues({
    area,
    name,
    traceId: options.traceId,
    sessionId,
    ...options.fields,
  });

  void logWithLevel(level, message, { keyValues }).catch(() => {
    const consoleMethod =
      level === "error" ? console.error : level === "warn" ? console.warn : console.info;
    consoleMethod(message);
  });
}

export function createTraceId(prefix = "trace") {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function stringifyError(err: unknown): string {
  if (err instanceof Error) {
    return err.stack || `${err.name}: ${err.message}`;
  }
  if (typeof err === "string") return err;
  return stableStringify(err);
}

export function stableStringify(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, inner) => {
      if (inner instanceof Error) {
        return stringifyError(inner);
      }
      return inner;
    });
  } catch {
    return String(value);
  }
}

export function toKeyValues(fields: Fields): Record<string, string> {
  return Object.fromEntries(
    Object.entries(fields)
      .filter((entry): entry is [string, Exclude<FieldValue, undefined>] => entry[1] !== undefined)
      .map(([key, value]) => [key, typeof value === "string" ? value : stableStringify(value)]),
  );
}

function observePerformance(windowLabel: string) {
  if (!("PerformanceObserver" in window)) return;

  if (PerformanceObserver.supportedEntryTypes.includes("measure")) {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (!entry.name.startsWith("macroni:")) continue;
        if (entry.duration < MEASURE_WARN_MS) continue;
        logEvent("warn", "frontend.performance", "measure", {
          fields: {
            windowLabel,
            name: entry.name,
            durationMs: roundMs(entry.duration),
            startTimeMs: roundMs(entry.startTime),
          },
        });
      }
    });
    observer.observe({ entryTypes: ["measure"] });
  }

  if (PerformanceObserver.supportedEntryTypes.includes("longtask")) {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        logEvent("warn", "frontend.performance", "long_task", {
          fields: {
            windowLabel,
            durationMs: roundMs(entry.duration),
            startTimeMs: roundMs(entry.startTime),
          },
        });
      }
    });
    observer.observe({ type: "longtask", buffered: true });
  }
}

function logWithLevel(
  level: LogLevel,
  message: string,
  options: { keyValues: Record<string, string> },
) {
  switch (level) {
    case "trace":
      return trace(message, options);
    case "debug":
      return debug(message, options);
    case "info":
      return info(message, options);
    case "warn":
      return warn(message, options);
    case "error":
      return error(message, options);
  }
}

function roundMs(ms: number) {
  return Math.round(ms * 100) / 100;
}
