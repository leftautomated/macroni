import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  AppWindow,
  ArrowUp,
  CheckCircle2,
  ExternalLink,
  RotateCw,
  ShieldAlert,
  X,
  XCircle,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { invoke, logEvent } from "@/lib/observability";

const isMac = typeof navigator !== "undefined" && navigator.userAgent.includes("Mac");

interface Props {
  screenRecording: boolean | null;
  accessibility: boolean | null;
  needsScreenRecording: boolean;
  needsAccessibility: boolean;
  captureError: string | null;
  onRequestPermissions: () => void;
  onOpenScreenRecordingSettings: () => void;
  onOpenAccessibilitySettings: () => void;
  onRecheck: () => void;
  onDismissPermission: () => void;
  onDismissCaptureError: () => void;
}

export function PermissionAlert({
  screenRecording,
  accessibility,
  needsScreenRecording,
  needsAccessibility,
  captureError,
  onRequestPermissions,
  onOpenScreenRecordingSettings,
  onOpenAccessibilitySettings,
  onRecheck,
  onDismissPermission,
  onDismissCaptureError,
}: Props) {
  const [dragError, setDragError] = useState<string | null>(null);
  const needsPermissions = needsScreenRecording || needsAccessibility;

  if (!needsPermissions && !captureError) return null;

  return (
    <div className="flex flex-col gap-2 items-center">
      {needsPermissions && (
        <Card
          role="alert"
          aria-live="polite"
          className="flex items-start gap-3 px-3 py-2 w-fit max-w-2xl border-amber-500/40 bg-amber-500/10"
        >
          <ShieldAlert className="h-4 w-4 mt-0.5 text-amber-600 dark:text-amber-400 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium">Mac permissions required</p>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Grant Accessibility for input capture and Screen Recording for video. Restart Macroni
              after granting access.
            </p>

            <div className="mt-2 grid gap-1.5 text-xs sm:grid-cols-2">
              <PermissionStatus label="Accessibility" granted={accessibility} />
              <PermissionStatus label="Screen Recording" granted={screenRecording} />
            </div>

            {isMac && <PermissionDragRow onError={setDragError} />}
            {dragError && (
              <p className="mt-1.5 text-xs text-muted-foreground leading-relaxed">{dragError}</p>
            )}

            <div className="mt-2 flex flex-wrap gap-1.5">
              {isMac && (
                <>
                  <Button size="sm" variant="default" onClick={onRequestPermissions}>
                    <ShieldAlert className="h-3 w-3 mr-1" /> Request prompts
                  </Button>
                  {needsAccessibility && (
                    <Button size="sm" variant="outline" onClick={onOpenAccessibilitySettings}>
                      <ExternalLink className="h-3 w-3 mr-1" /> Accessibility
                    </Button>
                  )}
                  {needsScreenRecording && (
                    <Button size="sm" variant="outline" onClick={onOpenScreenRecordingSettings}>
                      <ExternalLink className="h-3 w-3 mr-1" /> Screen Recording
                    </Button>
                  )}
                </>
              )}
              <Button size="sm" variant="outline" onClick={onRecheck}>
                <RotateCw className="h-3 w-3 mr-1" /> Re-check
              </Button>
            </div>
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={onDismissPermission}
            aria-label="Dismiss permission notice"
            className="h-6 w-6 p-0 flex-shrink-0"
          >
            <X className="h-3 w-3" />
          </Button>
        </Card>
      )}
      {captureError && (
        <Card
          role="alert"
          aria-live="polite"
          className="flex items-start gap-3 px-3 py-2 w-fit max-w-2xl border-destructive/40 bg-destructive/10"
        >
          <AlertTriangle className="h-4 w-4 mt-0.5 text-destructive flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium">Video capture failed</p>
            <p className="text-xs text-muted-foreground break-words">{captureError}</p>
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={onDismissCaptureError}
            aria-label="Dismiss capture error"
            className="h-6 w-6 p-0 flex-shrink-0"
          >
            <X className="h-3 w-3" />
          </Button>
        </Card>
      )}
    </div>
  );
}

function PermissionStatus({ label, granted }: { label: string; granted: boolean | null }) {
  if (granted === null) {
    return <span className="text-muted-foreground">Checking {label}…</span>;
  }

  if (granted) {
    return (
      <span className="inline-flex items-center gap-1.5 text-emerald-700 dark:text-emerald-300">
        <CheckCircle2 className="h-3.5 w-3.5" />
        {label}
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5 text-destructive">
      <XCircle className="h-3.5 w-3.5" />
      {label}
    </span>
  );
}

function PermissionDragRow({ onError }: { onError: (message: string | null) => void }) {
  const rowRef = useRef<HTMLDivElement>(null);

  const installDragRegion = useCallback(async () => {
    const row = rowRef.current;
    if (!row) return;

    const rect = row.getBoundingClientRect();
    const scale = window.devicePixelRatio || 1;
    try {
      await invoke("install_permission_drag_region", {
        x: rect.left * scale,
        y: rect.top * scale,
        w: rect.width * scale,
        h: rect.height * scale,
      });
      onError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      onError(message);
      logEvent("warn", "permissions", "install_drag_region_failed", { error: err });
    }
  }, [onError]);

  useEffect(() => {
    void installDragRegion();

    const observer = new ResizeObserver(() => {
      void installDragRegion();
    });
    if (rowRef.current) observer.observe(rowRef.current);

    window.addEventListener("resize", installDragRegion);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", installDragRegion);
      void invoke("remove_permission_drag_region").catch((err) => {
        logEvent("warn", "permissions", "remove_drag_region_failed", { error: err });
      });
    };
  }, [installDragRegion]);

  return (
    <div className="mt-2 flex items-center gap-2">
      <ArrowUp className="h-5 w-5 text-blue-600 dark:text-blue-400" />
      <div
        ref={rowRef}
        className="flex min-h-11 flex-1 items-center gap-2 rounded-md border bg-background/80 px-2.5 py-2 shadow-sm"
      >
        <AppWindow className="h-6 w-6 text-primary" />
        <div className="min-w-0">
          <p className="truncate text-xs font-medium">Macroni</p>
          <p className="truncate text-xs text-muted-foreground">
            Drag this row into the open System Settings list.
          </p>
        </div>
      </div>
    </div>
  );
}
