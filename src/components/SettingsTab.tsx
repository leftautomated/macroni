import { Moon, Sun, Monitor, Keyboard, Shield, Video } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTheme } from "@/components/theme-provider";
import { useAppSettings } from "@/hooks/useAppSettings";
import type { CaptureQuality, CaptureSettings } from "@/types";

const isMac = navigator.userAgent.includes("Mac");
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
                  <kbd className="text-xs font-mono px-2 py-0.5 rounded bg-secondary/50 text-secondary-foreground">{s.keys}</kbd>
                </div>
              ))}
            </div>
          </div>

          <div className="h-px bg-border" />

          <div className="space-y-2">
            <h4 className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
              <Video className="h-3 w-3" /> Video Capture
            </h4>
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
              <Button variant={theme === "light" ? "default" : "outline"} size="sm" onClick={() => setTheme("light")} className="flex items-center gap-2">
                <Sun className="h-3.5 w-3.5" /> Light
              </Button>
              <Button variant={theme === "dark" ? "default" : "outline"} size="sm" onClick={() => setTheme("dark")} className="flex items-center gap-2">
                <Moon className="h-3.5 w-3.5" /> Dark
              </Button>
              <Button variant={theme === "system" ? "default" : "outline"} size="sm" onClick={() => setTheme("system")} className="flex items-center gap-2">
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
              Macroni needs <span className="font-medium text-foreground">Accessibility</span> permission to capture keyboard and mouse input
              {isMac ? " and " : ""}
              {isMac ? (<span className="font-medium text-foreground">Screen Recording</span>) : null}
              {isMac ? " permission to capture screen video." : "."}
              {isMac ? " Go to System Settings → Privacy & Security to enable Macroni." : " Grant input access in your system settings."}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
