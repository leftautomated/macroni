import { Moon, Sun, Monitor, Keyboard, Shield } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTheme } from "@/components/theme-provider";

const isMac = navigator.userAgent.includes("Mac");
const mod = isMac ? "⌘" : "Ctrl";

const SHORTCUTS = [
  { keys: `${mod} + Shift + R`, description: "Start / stop recording" },
  { keys: `${mod} + R`, description: "Start / stop playback" },
  { keys: `${mod} + M`, description: "Hide / show window" },
] as const;

export const SettingsTab = () => {
  const { setTheme, theme } = useTheme();

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold">Settings</h3>
        <p className="text-xs text-muted-foreground">
          Configure application preferences
        </p>
      </div>
      <div className="h-80 w-full rounded-lg border bg-muted/20 p-4 overflow-y-auto">
        <div className="space-y-5">
          <div className="space-y-2">
            <h4 className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
              <Keyboard className="h-3 w-3" />
              Keyboard Shortcuts
            </h4>
            <div className="space-y-1.5">
              {SHORTCUTS.map((shortcut) => (
                <div
                  key={shortcut.keys}
                  className="flex items-center justify-between text-sm"
                >
                  <span className="text-xs text-muted-foreground">
                    {shortcut.description}
                  </span>
                  <kbd className="text-xs font-mono px-2 py-0.5 rounded bg-secondary/50 text-secondary-foreground">
                    {shortcut.keys}
                  </kbd>
                </div>
              ))}
            </div>
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
                <Sun className="h-3.5 w-3.5" />
                Light
              </Button>
              <Button
                variant={theme === "dark" ? "default" : "outline"}
                size="sm"
                onClick={() => setTheme("dark")}
                className="flex items-center gap-2"
              >
                <Moon className="h-3.5 w-3.5" />
                Dark
              </Button>
              <Button
                variant={theme === "system" ? "default" : "outline"}
                size="sm"
                onClick={() => setTheme("system")}
                className="flex items-center gap-2"
              >
                <Monitor className="h-3.5 w-3.5" />
                System
              </Button>
            </div>
          </div>

          <div className="h-px bg-border" />

          <div className="space-y-2">
            <h4 className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
              <Shield className="h-3 w-3" />
              Permissions
            </h4>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Macroni needs <span className="font-medium text-foreground">Accessibility</span> permission
              to capture keyboard and mouse input.{" "}
              {isMac
                ? "Go to System Settings → Privacy & Security → Accessibility and enable Macroni."
                : "Grant input access in your system settings."}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

