import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AppSettings } from "@/types";

export const useAppSettings = () => {
  const [settings, setSettings] = useState<AppSettings | null>(null);

  useEffect(() => {
    invoke<AppSettings>("load_settings").then(setSettings).catch((err) => {
      console.error("Failed to load settings:", err);
    });
  }, []);

  const update = useCallback(async (next: AppSettings) => {
    await invoke("save_settings", { settings: next });
    setSettings(next);
  }, []);

  return { settings, update } as const;
};
