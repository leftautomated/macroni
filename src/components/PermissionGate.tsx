import { useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Accessibility, Camera, Check, Loader2, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { PermissionAssistantSourceRect } from "@/hooks/usePermissionStatus";

interface PermissionGateProps {
  accessibility: boolean | null;
  screenRecording: boolean | null;
  activeAssistantPanel: PermissionKind | null;
  onOpenAccessibilitySettings: (sourceRect?: PermissionAssistantSourceRect) => void;
  onOpenScreenRecordingSettings: (sourceRect?: PermissionAssistantSourceRect) => void;
}

type PermissionKind = "accessibility" | "screen-recording";

export function PermissionGate({
  accessibility,
  screenRecording,
  activeAssistantPanel,
  onOpenAccessibilitySettings,
  onOpenScreenRecordingSettings,
}: PermissionGateProps) {
  const win = useMemo(() => getCurrentWindow(), []);
  const primaryMissing: PermissionKind | null =
    accessibility !== true ? "accessibility" : screenRecording !== true ? "screen-recording" : null;

  return (
    <section
      aria-label="Enable Macroni permissions"
      className="relative w-[min(680px,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-white/10 bg-card/95 px-8 py-8 text-card-foreground"
      data-tauri-drag-region
    >
      <PermissionGateTrafficLights
        onClose={() => void win.close()}
        onMinimize={() => void win.minimize()}
      />
      <div className="relative mx-auto flex max-w-xl flex-col items-center text-center">
        <img src="/logo.svg" alt="" className="h-20 w-20 rounded-2xl shadow-lg shadow-black/15" />
        <h1 className="mt-6 text-3xl font-semibold tracking-normal">Enable Macroni</h1>
        <p className="mt-3 max-w-md text-sm leading-6 text-muted-foreground">
          Macroni needs these permissions to record macros on your Mac. They are only used when you
          start recording.
        </p>

        <div className="mt-8 grid w-full gap-3 text-left">
          <PermissionGateRow
            description="Captures keyboard and mouse input."
            granted={accessibility}
            icon={Accessibility}
            isPrimary={primaryMissing === "accessibility"}
            isSystemSettingsActive={activeAssistantPanel === "accessibility"}
            label="Accessibility"
            onAllow={onOpenAccessibilitySettings}
          />
          <PermissionGateRow
            description="Captures screen video for recordings."
            granted={screenRecording}
            icon={Camera}
            isPrimary={primaryMissing === "screen-recording"}
            isSystemSettingsActive={activeAssistantPanel === "screen-recording"}
            label="Screen Recording"
            onAllow={onOpenScreenRecordingSettings}
          />
        </div>
      </div>
    </section>
  );
}

function PermissionGateTrafficLights({
  onClose,
  onMinimize,
}: {
  onClose: () => void;
  onMinimize: () => void;
}) {
  const [hovered, setHovered] = useState(false);

  return (
    <>
      <style>{`
        .permission-traffic-lights { display: flex; align-items: center; gap: 8px; }
        .permission-traffic-light {
          width: 12px; height: 12px; padding: 0;
          border: none; border-radius: 999px;
          display: inline-flex; align-items: center; justify-content: center;
          box-shadow: inset 0 0 0 0.5px rgba(0,0,0,0.24);
        }
        .permission-traffic-light:not(:disabled) { cursor: pointer; }
        .permission-traffic-close { background: #ff5f57; }
        .permission-traffic-minimize { background: #febc2e; }
        .permission-traffic-zoom { background: #28c840; opacity: 0.45; }
        .permission-traffic-glyph { width: 10px; height: 10px; animation: permission-traffic-glyph-in 90ms ease; }
        .permission-traffic-glyph path { stroke: rgba(0,0,0,0.56); stroke-width: 1.3; stroke-linecap: round; fill: none; }
        @keyframes permission-traffic-glyph-in { from { opacity: 0; } to { opacity: 1; } }
      `}</style>
      <div
        className="permission-traffic-lights absolute left-5 top-5 z-10"
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
        onDoubleClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          className="permission-traffic-light permission-traffic-close"
          aria-label="Close window"
          onClick={onClose}
        >
          {hovered && (
            <svg className="permission-traffic-glyph" viewBox="0 0 10 10" aria-hidden="true">
              <path d="M3 3l4 4M7 3l-4 4" />
            </svg>
          )}
        </button>
        <button
          type="button"
          className="permission-traffic-light permission-traffic-minimize"
          aria-label="Minimize window"
          onClick={onMinimize}
        >
          {hovered && (
            <svg className="permission-traffic-glyph" viewBox="0 0 10 10" aria-hidden="true">
              <path d="M3 5h4" />
            </svg>
          )}
        </button>
        <button
          type="button"
          className="permission-traffic-light permission-traffic-zoom"
          aria-label="Zoom unavailable"
          disabled
        >
          {hovered && (
            <svg className="permission-traffic-glyph" viewBox="0 0 10 10" aria-hidden="true">
              <path d="M5 3v4M3 5h4" />
            </svg>
          )}
        </button>
      </div>
    </>
  );
}

function PermissionGateRow({
  description,
  granted,
  icon: Icon,
  isPrimary,
  isSystemSettingsActive,
  label,
  onAllow,
}: {
  description: string;
  granted: boolean | null;
  icon: LucideIcon;
  isPrimary: boolean;
  isSystemSettingsActive: boolean;
  label: string;
  onAllow: (sourceRect?: PermissionAssistantSourceRect) => void;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const allow = () => {
    const rect = rowRef.current?.getBoundingClientRect();
    onAllow(rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : undefined);
  };

  if (isSystemSettingsActive && granted !== true) {
    return (
      <div
        ref={rowRef}
        className="flex min-h-24 items-center justify-center rounded-xl border border-dashed border-white/15 bg-secondary/25 px-5 py-4"
      >
        <span className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          Complete in System Settings
        </span>
      </div>
    );
  }

  return (
    <div
      ref={rowRef}
      className="flex min-h-24 items-center gap-4 rounded-xl border border-white/10 bg-secondary/55 px-5 py-4"
    >
      <Icon className="h-10 w-10 shrink-0 text-primary" />
      <div className="min-w-0 flex-1">
        <p className="text-lg font-semibold leading-6">{label}</p>
        <p className="mt-1 text-sm leading-5 text-muted-foreground">{description}</p>
      </div>
      <PermissionGateAction granted={granted} isPrimary={isPrimary} onAllow={allow} />
    </div>
  );
}

function PermissionGateAction({
  granted,
  isPrimary,
  onAllow,
}: {
  granted: boolean | null;
  isPrimary: boolean;
  onAllow: () => void;
}) {
  if (granted === true) {
    return (
      <div className="inline-flex min-w-24 items-center justify-center gap-1.5 text-sm font-semibold text-foreground">
        Done <Check className="h-4 w-4" />
      </div>
    );
  }

  if (granted === null) {
    return (
      <div className="inline-flex min-w-24 items-center justify-center gap-2 text-sm font-medium text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Checking
      </div>
    );
  }

  return (
    <Button
      size="sm"
      variant={isPrimary ? "default" : "secondary"}
      className={cn("min-w-24", isPrimary && "bg-blue-600 text-white hover:bg-blue-500")}
      onClick={onAllow}
    >
      Allow
    </Button>
  );
}
