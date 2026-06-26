import { useEffect, useState } from "react";
import { Bug, Copy, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
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

  const latestLog = snapshot?.logFiles[snapshot.logFiles.length - 1];
  const recentLines = snapshot?.recentLogLines.slice(-6) ?? [];

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
          <Bug className="h-3 w-3" /> Diagnostics
        </h4>
        <div className="flex gap-1.5">
          <Button size="sm" variant="outline" onClick={refresh} disabled={isLoading}>
            <RotateCw className="h-3 w-3 mr-1" /> {isLoading ? "Loading" : "Refresh"}
          </Button>
          <Button size="sm" variant="outline" onClick={handleCopy} disabled={isLoading}>
            <Copy className="h-3 w-3 mr-1" /> {copyLabel(copyState)}
          </Button>
        </div>
      </div>

      <div className="rounded-md border bg-background/60 p-3 space-y-2 text-xs">
        <div className="grid gap-1 sm:grid-cols-2">
          <DiagnosticValue label="Version" value={snapshot?.appVersion ?? "Unknown"} />
          <DiagnosticValue
            label="Runtime"
            value={snapshot ? `${snapshot.os} / ${snapshot.arch}` : "Unknown"}
          />
          <DiagnosticValue label="Recording" value={snapshot?.isRecording ? "Active" : "Idle"} />
          <DiagnosticValue label="Playback" value={snapshot?.isPlaying ? "Active" : "Idle"} />
        </div>

        <DiagnosticPath label="Log directory" value={snapshot?.appLogDir} />
        <DiagnosticPath
          label="Latest log"
          value={latestLog ? `${latestLog.path} (${formatBytes(latestLog.bytes)})` : null}
        />
        <DiagnosticPath
          label="Crash log"
          value={
            snapshot?.crashLogPath
              ? `${snapshot.crashLogPath} (${formatBytes(snapshot.crashLogBytes ?? 0)})`
              : null
          }
        />

        {recentLines.length > 0 && (
          <pre className="max-h-28 overflow-auto rounded bg-muted/50 p-2 text-[11px] leading-relaxed whitespace-pre-wrap">
            {recentLines.join("\n")}
          </pre>
        )}

        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
    </div>
  );
};

function DiagnosticValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium text-foreground">{value}</span>
    </div>
  );
}

function DiagnosticPath({ label, value }: { label: string; value?: string | null }) {
  return (
    <div className="space-y-0.5">
      <p className="text-muted-foreground">{label}</p>
      <p className="break-all font-mono text-[11px] text-foreground">{value ?? "Unavailable"}</p>
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
