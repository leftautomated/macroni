import { useMemo, useRef, useState, type MouseEvent, type PointerEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { toPng } from "html-to-image";
import { Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { PermissionAssistantSourceRect } from "@/hooks/usePermissionStatus";

interface PermissionGateProps {
  accessibility: boolean | null;
  screenRecording: boolean | null;
  activeAssistantPanel: PermissionKind | null;
  onClose?: () => void;
  onOpenAccessibilitySettings: (sourceRect?: PermissionAssistantSourceRect) => void;
  onOpenScreenRecordingSettings: (sourceRect?: PermissionAssistantSourceRect) => void;
}

type PermissionKind = "accessibility" | "screen-recording";

export function PermissionGate({
  accessibility,
  screenRecording,
  activeAssistantPanel,
  onClose,
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
        onClose={onClose ?? (() => void win.hide())}
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
            isPrimary={primaryMissing === "accessibility"}
            isSystemSettingsActive={activeAssistantPanel === "accessibility"}
            kind="accessibility"
            label="Accessibility"
            onAllow={onOpenAccessibilitySettings}
          />
          <PermissionGateRow
            description="Captures screen video for recordings."
            granted={screenRecording}
            isPrimary={primaryMissing === "screen-recording"}
            isSystemSettingsActive={activeAssistantPanel === "screen-recording"}
            kind="screen-recording"
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
  const stopWindowDrag = (event: MouseEvent | PointerEvent) => {
    event.stopPropagation();
    event.nativeEvent.stopImmediatePropagation();
  };

  return (
    <>
      <style>{`
        .permission-traffic-lights { display: flex; align-items: center; gap: 8px; }
        .permission-traffic-light {
          position: relative;
          flex: 0 0 12px;
          box-sizing: border-box;
          width: 12px; height: 12px; padding: 0;
          border: 1px solid transparent; border-radius: 999px;
          appearance: none; -webkit-appearance: none;
          display: block;
          line-height: 0;
          box-shadow: inset 0 0 0 0.5px rgba(0,0,0,0.24);
        }
        .permission-traffic-light:not(:disabled) { cursor: pointer; }
        .permission-traffic-close { background: #ff5f57; }
        .permission-traffic-minimize { background: #febc2e; }
        .permission-traffic-zoom { background: #28c840; opacity: 0.45; }
        .permission-traffic-glyph {
          position: absolute;
          inset: 1px;
          display: block;
          width: 10px; height: 10px;
          pointer-events: none;
          animation: permission-traffic-glyph-in 100ms ease;
        }
        .permission-traffic-glyph path { stroke: rgba(0,0,0,0.56); stroke-width: 1.3; stroke-linecap: round; fill: none; }
        @keyframes permission-traffic-glyph-in { from { opacity: 0; } to { opacity: 1; } }
      `}</style>
      <div
        className={cn(
          "permission-traffic-lights absolute left-5 top-5 z-10",
          hovered && "is-hovered",
        )}
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
        onPointerCancel={() => setHovered(false)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onPointerDownCapture={stopWindowDrag}
        onMouseDownCapture={stopWindowDrag}
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
  isPrimary,
  isSystemSettingsActive,
  kind,
  label,
  onAllow,
}: {
  description: string;
  granted: boolean | null;
  isPrimary: boolean;
  isSystemSettingsActive: boolean;
  kind: PermissionKind;
  label: string;
  onAllow: (sourceRect?: PermissionAssistantSourceRect) => void;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const allow = async () => {
    const row = rowRef.current;
    const rect = row?.getBoundingClientRect();
    const scale = window.devicePixelRatio || 1;
    let sourceImageDataUrl: string | undefined;

    if (row) {
      try {
        sourceImageDataUrl = await toPng(row, {
          cacheBust: true,
          pixelRatio: scale,
        });
      } catch {
        sourceImageDataUrl = undefined;
      }
    }

    onAllow(
      rect
        ? {
            x: rect.x * scale,
            y: rect.y * scale,
            width: rect.width * scale,
            height: rect.height * scale,
            sourceImageDataUrl,
          }
        : undefined,
    );
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
      <NativePermissionIcon kind={kind} />
      <div className="min-w-0 flex-1">
        <p className="text-lg font-semibold leading-6">{label}</p>
        <p className="mt-1 text-sm leading-5 text-muted-foreground">{description}</p>
      </div>
      <PermissionGateAction granted={granted} isPrimary={isPrimary} onAllow={allow} />
    </div>
  );
}

function NativePermissionIcon({ kind }: { kind: PermissionKind }) {
  if (kind === "accessibility") {
    return (
      <svg aria-hidden="true" className="h-10 w-10 shrink-0 text-primary" viewBox="0 0 44 44">
        <circle cx="22" cy="22" r="17.5" fill="none" stroke="currentColor" strokeWidth="3" />
        <circle cx="22" cy="14.6" r="3.4" fill="currentColor" />
        <path
          d="M12.8 20.4c3.9-1.35 7-2.02 9.2-2.02s5.3.67 9.2 2.02"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="3"
        />
        <path
          d="M22 18.7v8.15m0 0-6.3 8.45m6.3-8.45 6.3 8.45"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="3"
        />
      </svg>
    );
  }

  return (
    <svg aria-hidden="true" className="h-10 w-10 shrink-0 text-primary" viewBox="0 0 44 44">
      <path
        d="M12.8 15.9h4.35l2.1-3.1h5.5l2.1 3.1h4.35c3.1 0 5.3 2.15 5.3 5.2v8.2c0 3.05-2.2 5.2-5.3 5.2H12.8c-3.1 0-5.3-2.15-5.3-5.2v-8.2c0-3.05 2.2-5.2 5.3-5.2Z"
        fill="none"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="3"
      />
      <circle cx="22" cy="25.2" r="6.15" fill="none" stroke="currentColor" strokeWidth="3" />
      <circle cx="31.3" cy="21.2" r="1.6" fill="currentColor" />
    </svg>
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
      className={cn(
        "min-w-24",
        isPrimary && "bg-primary text-primary-foreground hover:bg-[#e5b853]",
      )}
      onClick={onAllow}
    >
      Allow
    </Button>
  );
}
