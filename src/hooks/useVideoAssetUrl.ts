import { useEffect, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import type { VideoMetadata } from "@/types";

/**
 * Resolve a VideoMetadata (whose `path` is relative to app data dir) into a
 * URL the `<video>` element can stream from via the Tauri asset protocol.
 */
export function useVideoAssetUrl(video: VideoMetadata | null | undefined) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!video) {
      setUrl(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const appDataDir = await invoke<string>("get_app_data_dir");
        if (cancelled) return;
        const full = `${appDataDir}/videos/${video.path}`;
        setUrl(convertFileSrc(full));
      } catch (e) {
        setError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [video]);

  return { url, error } as const;
}
