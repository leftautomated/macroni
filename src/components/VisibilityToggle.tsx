import { Button } from "@/components/ui/button";
import { invoke, logEvent } from "@/lib/observability";
import { Eye } from "lucide-react";

export const VisibilityToggle = () => {
  const handleToggle = async () => {
    try {
      await invoke<boolean>("toggle_visibility");
    } catch (error) {
      logEvent("error", "window", "toggle_visibility_failed", { error });
    }
  };

  const isMac = navigator.userAgent.includes("Mac");
  const shortcutHint = isMac ? "⌘ + M" : "Ctrl + M";

  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-8 w-8"
      onClick={handleToggle}
      title={`Toggle visibility (${shortcutHint})`}
    >
      <Eye className="h-3.5 w-3.5" />
    </Button>
  );
};
