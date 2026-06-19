import { ShieldAlert, ExternalLink, RotateCw, X, AlertTriangle } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

const isMac = typeof navigator !== "undefined" && navigator.userAgent.includes("Mac");

interface Props {
  needsScreenRecording: boolean;
  captureError: string | null;
  onOpenSystemSettings: () => void;
  onRecheck: () => void;
  onDismissPermission: () => void;
  onDismissCaptureError: () => void;
}

export function PermissionAlert({
  needsScreenRecording,
  captureError,
  onOpenSystemSettings,
  onRecheck,
  onDismissPermission,
  onDismissCaptureError,
}: Props) {
  if (!needsScreenRecording && !captureError) return null;

  return (
    <div className="flex flex-col gap-2 items-center">
      {needsScreenRecording && (
        <Card
          role="alert"
          aria-live="polite"
          className="flex items-start gap-3 px-3 py-2 w-fit max-w-2xl border-amber-500/40 bg-amber-500/10"
        >
          <ShieldAlert className="h-4 w-4 mt-0.5 text-amber-600 dark:text-amber-400 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium">Screen Recording permission required</p>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Macroni can record input events without it, but video capture is disabled until you
              grant access in System Settings. Restart the app after granting.
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {isMac && (
                <Button size="sm" variant="default" onClick={onOpenSystemSettings}>
                  <ExternalLink className="h-3 w-3 mr-1" /> Open System Settings
                </Button>
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
