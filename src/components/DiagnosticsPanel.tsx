import { useEffect, useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Bug, Copy, FolderOpen, RotateCw } from "lucide-react";
import { useDiagnosticsSnapshot } from "@/hooks/useDiagnosticsSnapshot";
import { logEvent } from "@/lib/observability";
import type { DiagnosticsSnapshot } from "@/types";

type CopyState = "idle" | "copied" | "failed";

export const DiagnosticsPanel = () => {
  const { error, isLoading, refresh, snapshot } = useDiagnosticsSnapshot();
  const [copyState, setCopyState] = useState<CopyState>("idle");

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleCopy = async () => {
    const current = snapshot ?? (await refresh());
    if (!current) return;

    try {
      await navigator.clipboard.writeText(JSON.stringify(current, null, 2));
      setCopyState("copied");
      logEvent("info", "diagnostics", "snapshot_copied");
    } catch (err) {
      setCopyState("failed");
      logEvent("error", "diagnostics", "copy_failed", { error: err });
    }
  };

  // Reveal a log file/folder in Finder instead of dumping its contents here.
  const reveal = async (path: string) => {
    try {
      await revealItemInDir(path);
      logEvent("info", "diagnostics", "reveal_log", { fields: { path } });
    } catch (err) {
      logEvent("error", "diagnostics", "reveal_failed", { error: err, fields: { path } });
    }
  };

  const latestLog = snapshot?.logFiles[snapshot.logFiles.length - 1];

  return (
    <section className="diag-section">
      <style>{`
        .diag-section { display: flex; flex-direction: column; gap: 9px; }
        .diag-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
        .diag-title {
          display: flex; align-items: center; gap: 7px; padding-left: 3px;
          font-size: 11px; font-weight: 600; letter-spacing: 0.07em; text-transform: uppercase;
          color: var(--studio-text-subtle);
        }
        .diag-title svg { width: 13px; height: 13px; color: var(--studio-accent); }
        .diag-actions { display: inline-flex; gap: 6px; }
        .diag-btn {
          display: inline-flex; align-items: center; gap: 6px;
          font: inherit; font-size: 12px; font-weight: 500; color: var(--studio-text-strong);
          background: var(--studio-hover);
          border: 1px solid var(--studio-border); border-radius: 7px;
          padding: 5px 10px; cursor: pointer;
          transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
        }
        .diag-btn svg { width: 13px; height: 13px; }
        .diag-btn:hover:not(:disabled) { background: var(--studio-accent-soft); color: var(--studio-accent); border-color: var(--studio-accent-border); }
        .diag-btn:disabled { opacity: 0.5; cursor: default; }
        .diag-panel {
          border: 1px solid var(--studio-border);
          background: var(--studio-surface-soft);
          border-radius: 12px; padding: 13px 14px;
          display: flex; flex-direction: column; gap: 11px;
        }
        .diag-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 7px 20px; }
        .diag-kv { display: flex; align-items: center; justify-content: space-between; gap: 12px; font-size: 12px; }
        .diag-k { color: var(--studio-text-muted); }
        .diag-v { color: var(--studio-text-strong); font-weight: 500; }
        .diag-divider { height: 1px; background: var(--studio-border); }
        .diag-path { display: flex; flex-direction: column; gap: 3px; }
        .diag-path-k { font-size: 11px; color: var(--studio-text-muted); }
        .diag-path-link {
          appearance: none; border: 1px solid transparent; border-radius: 4px;
          background: transparent; padding: 1px 2px; margin: -2px -3px;
          display: inline-flex; align-items: center; gap: 6px; text-align: left; cursor: pointer;
          color: var(--studio-text-muted); transition: color 120ms ease; min-width: 0;
        }
        .diag-path-link svg { width: 13px; height: 13px; flex-shrink: 0; color: var(--studio-text-subtle); transition: color 120ms ease; }
        .diag-path-link:hover { color: var(--studio-accent); }
        .diag-path-link:hover svg { color: var(--studio-accent); }
        .diag-path-link:hover .diag-path-v { text-decoration: underline; text-underline-offset: 2px; }
        .diag-path-v {
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          font-size: 11px; word-break: break-all;
        }
        .diag-path-na {
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          font-size: 11px; color: var(--studio-text-subtle);
        }
        .diag-error { font-size: 12px; color: var(--studio-danger); }
      `}</style>

      <div className="diag-head">
        <div className="diag-title">
          <Bug /> Diagnostics
        </div>
        <div className="diag-actions">
          <button type="button" className="diag-btn" onClick={refresh} disabled={isLoading}>
            <RotateCw /> {isLoading ? "Loading" : "Refresh"}
          </button>
          <button type="button" className="diag-btn" onClick={handleCopy} disabled={isLoading}>
            <Copy /> {copyLabel(copyState)}
          </button>
        </div>
      </div>

      <div className="diag-panel">
        <div className="diag-grid">
          <DiagnosticValue label="Version" value={snapshot?.appVersion ?? "Unknown"} />
          <DiagnosticValue
            label="Runtime"
            value={snapshot ? `${snapshot.os} / ${snapshot.arch}` : "Unknown"}
          />
          <DiagnosticValue label="Recording" value={snapshot?.isRecording ? "Active" : "Idle"} />
          <DiagnosticValue label="Playback" value={snapshot?.isPlaying ? "Active" : "Idle"} />
        </div>

        <div className="diag-divider" />

        <DiagnosticPath
          label="Log folder"
          path={snapshot?.appLogDir}
          display={snapshot?.appLogDir}
          onReveal={reveal}
        />
        <DiagnosticPath
          label="Latest log"
          path={latestLog?.path}
          display={latestLog ? `${latestLog.path} (${formatBytes(latestLog.bytes)})` : null}
          onReveal={reveal}
        />
        <DiagnosticPath
          label="Crash log"
          path={snapshot?.crashLogPath}
          display={
            snapshot?.crashLogPath
              ? `${snapshot.crashLogPath} (${formatBytes(snapshot.crashLogBytes ?? 0)})`
              : null
          }
          onReveal={reveal}
        />

        {error && <p className="diag-error">{error}</p>}
      </div>
    </section>
  );
};

function DiagnosticValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="diag-kv">
      <span className="diag-k">{label}</span>
      <span className="diag-v">{value}</span>
    </div>
  );
}

function DiagnosticPath({
  label,
  path,
  display,
  onReveal,
}: {
  label: string;
  path?: string | null;
  display?: string | null;
  onReveal: (path: string) => void;
}) {
  return (
    <div className="diag-path">
      <span className="diag-path-k">{label}</span>
      {path && display ? (
        <button
          type="button"
          className="diag-path-link"
          title="Reveal in Finder"
          onClick={() => onReveal(path)}
        >
          <FolderOpen />
          <span className="diag-path-v">{display}</span>
        </button>
      ) : (
        <span className="diag-path-na">Unavailable</span>
      )}
    </div>
  );
}

function copyLabel(copyState: CopyState) {
  if (copyState === "copied") return "Copied";
  if (copyState === "failed") return "Failed";
  return "Copy";
}

function formatBytes(bytes: DiagnosticsSnapshot["crashLogBytes"]) {
  const value = bytes ?? 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}
