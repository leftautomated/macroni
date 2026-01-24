import { Moon, Sun, Monitor } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTheme } from "@/components/theme-provider";

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
      <div className="h-80 w-full rounded-lg border bg-muted/20 p-4">
        <div className="space-y-4">
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
        </div>
      </div>
    </div>
  );
};

