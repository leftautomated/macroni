import { useCallback, useState } from "react";
import { X } from "lucide-react";
import { invoke, logEvent } from "@/lib/observability";
import type { ObservationResult, PerceptionTarget, Recording, TargetKind } from "@/types";

interface PerceptionPanelProps {
  recordingId: string;
  targets: PerceptionTarget[];
  /** Current playhead, video-relative ms — used as the frame timestamp for "Test frame". */
  playheadMs: number;
  onRecordingUpdate: (rec: Recording) => void;
}

type ExtractSource =
  | { type: "Live" }
  | { type: "Recording"; recording_id: string; timestamp_ms: number };

function kindLabel(kind: TargetKind): string {
  switch (kind.type) {
    case "TextOcr":
      return "Text";
    case "TemplateMatch":
      return "Image";
    case "ColorSample":
      return "Color";
  }
}

/** Inline result summary for one row, per the ObservationResult variant. */
function ResultView({ result }: { result: ObservationResult | "error" }) {
  if (result === "error") {
    return <span className="pp-result pp-result-error">Error</span>;
  }
  switch (result.type) {
    case "Text": {
      const text = result.spans
        .map((s) => s.text)
        .join(" ")
        .trim();
      return <span className="pp-result">{text || "no text found"}</span>;
    }
    case "Template": {
      const label = `${result.matched ? "match" : "no match"} ${result.score.toFixed(2)}`;
      return <span className={`pp-result${result.matched ? " pp-match" : ""}`}>{label}</span>;
    }
    case "Color": {
      const [r, g, b] = result.rgb;
      return (
        <span className={`pp-result pp-color${result.matched ? " pp-match" : ""}`}>
          <span className="pp-swatch" style={{ background: `rgb(${r}, ${g}, ${b})` }} />
          rgb({r}, {g}, {b}) · {result.matched ? "match" : "no match"}
        </span>
      );
    }
  }
}

/**
 * Bottom-panel list of a recording's perception targets: name + kind, with
 * "Test frame" (extracts against the current playhead in this recording) and
 * "Test live" (extracts against the live screen) actions, an inline result
 * summary, and delete. Targets without a saved region (e.g. an
 * in-progress TemplateMatch) can't be tested, so their actions are disabled.
 */
export function PerceptionPanel({
  recordingId,
  targets,
  playheadMs,
  onRecordingUpdate,
}: PerceptionPanelProps) {
  const [results, setResults] = useState<Record<string, ObservationResult | "error">>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});

  const runTest = useCallback(
    async (target: PerceptionTarget, source: ExtractSource) => {
      if (!target.region) return;
      setBusy((b) => ({ ...b, [target.id]: true }));
      try {
        const result = await invoke<ObservationResult>("extract_region", {
          source,
          region: target.region,
          kind: target.kind,
        });
        setResults((r) => ({ ...r, [target.id]: result }));
      } catch (e) {
        setResults((r) => ({ ...r, [target.id]: "error" }));
        logEvent("error", "studio.perception", "extract_region_failed", {
          error: e,
          fields: { recordingId, targetId: target.id },
        });
      } finally {
        setBusy((b) => ({ ...b, [target.id]: false }));
      }
    },
    [recordingId],
  );

  const handleDelete = useCallback(
    async (targetId: string) => {
      try {
        const updated = await invoke<Recording>("delete_target", { recordingId, targetId });
        onRecordingUpdate(updated);
      } catch (e) {
        logEvent("error", "studio.perception", "delete_target_failed", {
          error: e,
          fields: { recordingId, targetId },
        });
      }
    },
    [recordingId, onRecordingUpdate],
  );

  return (
    <div className="pp-root">
      <style>{`
        .pp-root { display: flex; flex-direction: column; gap: 6px; }
        .pp-row { display: flex; align-items: center; gap: 10px; padding: 6px 8px; border-radius: 8px; background: var(--studio-surface-soft); }
        .pp-name { font-size: 12px; font-weight: 600; color: var(--studio-text); white-space: nowrap; }
        .pp-kind { font-size: 11px; color: var(--studio-text-subtle); border: 1px solid var(--studio-border-strong); border-radius: 999px; padding: 1px 8px; white-space: nowrap; }
        .pp-btn { display: inline-flex; align-items: center; border: 1px solid var(--studio-border-strong); background: transparent; color: var(--studio-text-muted); border-radius: 6px; padding: 4px 9px; font-size: 11px; cursor: pointer; white-space: nowrap; transition: background 120ms ease, color 120ms ease; }
        .pp-btn:hover:not(:disabled) { background: var(--studio-hover); color: var(--studio-text); }
        .pp-btn:disabled { opacity: 0.35; cursor: default; }
        .pp-del { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border: 1px solid transparent; background: transparent; color: var(--studio-text-subtle); border-radius: 6px; cursor: pointer; transition: background 120ms ease, border-color 120ms ease, color 120ms ease; }
        .pp-del:hover { background: var(--studio-danger-soft); color: var(--studio-danger); }
        .pp-result { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; color: var(--studio-text-muted); display: inline-flex; align-items: center; gap: 6px; }
        .pp-result.pp-match { color: var(--studio-success); }
        .pp-result-error { color: var(--studio-danger); }
        .pp-swatch { width: 11px; height: 11px; border-radius: 3px; border: 1px solid var(--studio-border-strong); flex-shrink: 0; }
      `}</style>

      {targets.map((target) => {
        const testable = !!target.region;
        const isBusy = !!busy[target.id];
        const result = results[target.id];
        return (
          <div key={target.id} className="pp-row">
            <span className="pp-name">{target.name}</span>
            <span className="pp-kind">{kindLabel(target.kind)}</span>
            <button
              type="button"
              className="pp-btn"
              disabled={!testable || isBusy}
              onClick={() =>
                void runTest(target, {
                  type: "Recording",
                  recording_id: recordingId,
                  timestamp_ms: playheadMs,
                })
              }
            >
              Test frame
            </button>
            <button
              type="button"
              className="pp-btn"
              disabled={!testable || isBusy}
              onClick={() => void runTest(target, { type: "Live" })}
            >
              Test live
            </button>
            {result !== undefined ? <ResultView result={result} /> : <span className="pp-result" />}
            <button
              type="button"
              className="pp-del"
              aria-label={`Delete ${target.name}`}
              title="Delete target"
              onClick={() => void handleDelete(target.id)}
            >
              <X size={13} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
