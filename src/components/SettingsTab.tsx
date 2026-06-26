import {
  Moon,
  Sun,
  Monitor,
  Keyboard,
  Shield,
  Video,
  CheckCircle2,
  XCircle,
  ExternalLink,
  RotateCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { DiagnosticsPanel } from "@/components/DiagnosticsPanel";
import { useTheme } from "@/components/theme-provider";
import { useAppSettings } from "@/hooks/useAppSettings";
import { usePermissionStatus } from "@/hooks/usePermissionStatus";
import type { CaptureQuality, CaptureSettings } from "@/types";

const isMac = navigator.userAgent.includes("Mac");
const isWindows = navigator.userAgent.includes("Win");
const mod = isMac ? "⌘" : "Ctrl";

const SHORTCUTS = [
  { keys: `${mod} + Shift + R`, description: "Start / stop recording" },
  { keys: `${mod} + R`, description: "Start / stop playback" },
  { keys: `${mod} + M`, description: "Hide / show window" },
] as const;

const FPS_OPTIONS: Array<15 | 30 | 60> = [15, 30, 60];
const QUALITY_OPTIONS: CaptureQuality[] = ["low", "med", "high"];

export const SettingsTab = () => {
  const { setTheme, theme } = useTheme();
  const { settings, update } = useAppSettings();
  const perms = usePermissionStatus();

  const setCapture = (partial: Partial<CaptureSettings>) => {
    if (!settings) return;
    update({ ...settings, capture: { ...settings.capture, ...partial } });
  };

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold">Settings</h3>
        <p className="text-xs text-muted-foreground">Configure application preferences</p>
      </div>
      <div className="h-80 w-full rounded-lg border bg-muted/20 p-4 overflow-y-auto">
        <div className="space-y-5">
          <div className="space-y-2">
            <h4 className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
              <Keyboard className="h-3 w-3" /> Keyboard Shortcuts
            </h4>
            <div className="space-y-1.5">
              {SHORTCUTS.map((s) => (
                <div key={s.keys} className="flex items-center justify-between text-sm">
                  <span className="text-xs text-muted-foreground">{s.description}</span>
                  <kbd className="text-xs font-mono px-2 py-0.5 rounded bg-secondary/50 text-secondary-foreground">
                    {s.keys}
                  </kbd>
                </div>
              ))}
            </div>
          </div>

          <div className="h-px bg-border" />

          <div className="space-y-2">
            <h4 className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
              <Video className="h-3 w-3" /> Video Capture
            </h4>
            {isWindows && (
              <p className="text-xs text-muted-foreground italic">
                Video capture is temporarily unavailable on Windows (upstream library issue). Event
                recording still works. These settings apply once video support ships.
              </p>
            )}
            {settings ? (
              <div className="space-y-3">
                <div>
                  <p className="text-xs text-muted-foreground mb-1.5">Frame rate</p>
                  <div className="flex gap-2">
                    {FPS_OPTIONS.map((fps) => (
                      <Button
                        key={fps}
                        variant={settings.capture.fps === fps ? "default" : "outline"}
                        size="sm"
                        onClick={() => setCapture({ fps })}
                      >
                        {fps} fps
                      </Button>
                    ))}
                  </div>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground mb-1.5">Quality</p>
                  <div className="flex gap-2">
                    {QUALITY_OPTIONS.map((q) => (
                      <Button
                        key={q}
                        variant={settings.capture.quality === q ? "default" : "outline"}
                        size="sm"
                        onClick={() => setCapture({ quality: q })}
                      >
                        {q.charAt(0).toUpperCase() + q.slice(1)}
                      </Button>
                    ))}
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <p className="text-xs text-muted-foreground">Capture system audio</p>
                  <Button
                    variant={settings.capture.audio ? "default" : "outline"}
                    size="sm"
                    onClick={() => setCapture({ audio: !settings.capture.audio })}
                  >
                    {settings.capture.audio ? "On" : "Off"}
                  </Button>
                </div>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">Loading…</p>
            )}
          </div>

          <div className="h-px bg-border" />

          <div className="space-y-2">
            <h4 className="text-xs font-medium text-muted-foreground">Theme</h4>
            <div className="flex gap-2">
              <Button
                variant={theme === "light" ? "default" : "outline"}
                size="sm"
                onClick={() => setTheme("light")}
                className="flex items-center gap-2"
              >
                <Sun className="h-3.5 w-3.5" /> Light
              </Button>
              <Button
                variant={theme === "dark" ? "default" : "outline"}
                size="sm"
                onClick={() => setTheme("dark")}
                className="flex items-center gap-2"
              >
                <Moon className="h-3.5 w-3.5" /> Dark
              </Button>
              <Button
                variant={theme === "system" ? "default" : "outline"}
                size="sm"
                onClick={() => setTheme("system")}
                className="flex items-center gap-2"
              >
                <Monitor className="h-3.5 w-3.5" /> System
              </Button>
            </div>
          </div>

          <div className="h-px bg-border" />

          <div className="space-y-2">
            <h4 className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
              <Shield className="h-3 w-3" /> Permissions
            </h4>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Macroni needs <span className="font-medium text-foreground">Accessibility</span>{" "}
              permission to capture keyboard and mouse input
              {isMac ? (
                <>
                  {" and "}
                  <span className="font-medium text-foreground">Screen Recording</span> permission
                  to capture screen video.
                </>
              ) : (
                "."
              )}
            </p>
            {isMac && (
              <div className="flex items-center justify-between gap-2 pt-1">
                <div className="flex items-center gap-2 text-xs">
                  {perms.state.screenRecording === null ? (
                    <span className="text-muted-foreground">Checking…</span>
                  ) : perms.state.screenRecording ? (
                    <>
                      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                      <span>Screen Recording: granted</span>
                    </>
                  ) : (
                    <>
                      <XCircle className="h-3.5 w-3.5 text-destructive" />
                      <span>Screen Recording: not granted</span>
                    </>
                  )}
                </div>
                <div className="flex gap-1.5">
                  <Button size="sm" variant="outline" onClick={perms.recheck}>
                    <RotateCw className="h-3 w-3 mr-1" /> Re-check
                  </Button>
                  <Button size="sm" variant="default" onClick={perms.openSystemSettings}>
                    <ExternalLink className="h-3 w-3 mr-1" /> Open Settings
                  </Button>
                </div>
              </div>
            )}
          </div>

          <div className="h-px bg-border" />

          <DiagnosticsPanel />
        </div>
      </div>
    </div>
  );
};
