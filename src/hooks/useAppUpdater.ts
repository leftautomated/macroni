import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, logEvent, stringifyError } from "@/lib/observability";
import type { DiagnosticsSnapshot } from "@/types";

export type UpdateStatus =
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "installing"
  | "error";

export interface AppUpdaterState {
  availableVersion: string | null;
  checkForUpdates: () => Promise<void>;
  currentVersion: string;
  error: string | null;
  installUpdate: () => Promise<void>;
  notes: string | null;
  progress: number | null;
  status: UpdateStatus;
}

export function useAppUpdater(): AppUpdaterState {
  const [currentVersion, setCurrentVersion] = useState("");
  const [availableVersion, setAvailableVersion] = useState<string | null>(null);
  const [notes, setNotes] = useState<string | null>(null);
  const [status, setStatus] = useState<UpdateStatus>("idle");
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const updateRef = useRef<Update | null>(null);
  const requestIdRef = useRef(0);
  const currentVersionRef = useRef("");

  const checkForUpdates = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setStatus("checking");
    setError(null);
    setProgress(null);

    const previous = updateRef.current;
    updateRef.current = null;
    if (previous) {
      await previous.close().catch(() => undefined);
    }

    try {
      const update = await check({ timeout: 15_000 });
      if (requestId !== requestIdRef.current) {
        await update?.close().catch(() => undefined);
        return;
      }

      if (!update) {
        setAvailableVersion(null);
        setNotes(null);
        setStatus("up-to-date");
        logEvent("info", "updater", "up_to_date", {
          fields: { currentVersion: currentVersionRef.current },
        });
        return;
      }

      updateRef.current = update;
      currentVersionRef.current = update.currentVersion;
      setCurrentVersion(update.currentVersion);
      setAvailableVersion(update.version);
      setNotes(update.body?.trim() || null);
      setStatus("available");
      logEvent("info", "updater", "update_available", {
        fields: { currentVersion: update.currentVersion, version: update.version },
      });
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      setError(stringifyError(err));
      setStatus("error");
      logEvent("error", "updater", "check_failed", { error: err });
    }
  }, []);

  const installUpdate = useCallback(async () => {
    const update = updateRef.current;
    if (!update) {
      await checkForUpdates();
      return;
    }

    setError(null);
    try {
      const diagnostics = await invoke<DiagnosticsSnapshot>(
        "get_diagnostics_snapshot",
        {},
        { area: "updater" },
      );
      if (diagnostics.isRecording || diagnostics.isPlaying) {
        throw new Error("Stop recording and playback before updating Macroni.");
      }

      let downloadedBytes = 0;
      let contentLength: number | undefined;
      setProgress(0);
      setStatus("downloading");

      await update.downloadAndInstall((event: DownloadEvent) => {
        if (event.event === "Started") {
          contentLength = event.data.contentLength;
          downloadedBytes = 0;
          setProgress(contentLength ? 0 : null);
          return;
        }
        if (event.event === "Progress") {
          downloadedBytes += event.data.chunkLength;
          if (contentLength) {
            setProgress(Math.min(100, Math.round((downloadedBytes / contentLength) * 100)));
          }
          return;
        }
        setProgress(100);
        setStatus("installing");
      });

      logEvent("info", "updater", "install_complete", {
        fields: { version: update.version },
      });
      await relaunch();
    } catch (err) {
      setError(stringifyError(err));
      setStatus("error");
      logEvent("error", "updater", "install_failed", {
        error: err,
        fields: { version: update.version },
      });
    }
  }, [checkForUpdates]);

  useEffect(() => {
    let cancelled = false;
    void getVersion()
      .then((version) => {
        if (!cancelled) {
          currentVersionRef.current = version;
          setCurrentVersion(version);
        }
      })
      .catch((err) => logEvent("warn", "updater", "version_read_failed", { error: err }));
    void checkForUpdates();

    return () => {
      cancelled = true;
      requestIdRef.current += 1;
      const update = updateRef.current;
      updateRef.current = null;
      if (update) void update.close().catch(() => undefined);
    };
  }, [checkForUpdates]);

  return {
    availableVersion,
    checkForUpdates,
    currentVersion,
    error,
    installUpdate,
    notes,
    progress,
    status,
  };
}
