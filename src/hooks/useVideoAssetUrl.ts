import { useEffect, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import type { VideoMetadata } from "@/types";

// The app data dir is constant for the session. Cache it so resolving a video
// URL is synchronous after the first lookup — switching recordings then updates
// the URL in the same render as the selection, with no Rust round-trip and no
// window where the URL still points at the previously selected video.
let cachedDir: string | null = null;

/**
 * Resolve a VideoMetadata (whose `path` is relative to app data dir) into a
 * URL the `<video>` element can stream from via the Tauri asset protocol.
 */
export function useVideoAssetUrl(video: VideoMetadata | null | undefined) {
  const [dir, setDir] = useState<string | null>(cachedDir);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (cachedDir !== null) {
      setDir(cachedDir);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const appDataDir = await invoke<string>("get_app_data_dir");
        cachedDir = appDataDir;
        if (!cancelled) setDir(appDataDir);
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Derived, not stored: url is always consistent with `video` within a render,
  // so a selection change can never momentarily show the prior video.
  const url = video && dir ? convertFileSrc(`${dir}/videos/${video.path}`) : null;

  return { url, error } as const;
}
