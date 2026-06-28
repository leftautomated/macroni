import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Settings } from "lucide-react";
import { SettingsTab } from "@/components/SettingsTab";
import { RecordingsMenu } from "@/components/studio/RecordingsMenu";
import { StudioPlayer, type StudioPlayerHandle } from "@/components/studio/StudioPlayer";
import { type LoopRegion, StudioTimeline } from "@/components/studio/StudioTimeline";
import { StudioTitleBar } from "@/components/studio/StudioTitleBar";
import { usePlaybackSync } from "@/hooks/usePlaybackSync";
import { useVideoAssetUrl } from "@/hooks/useVideoAssetUrl";
import { invoke, logEvent } from "@/lib/observability";
import { recordingTitle } from "@/lib/recording-format";
import type { Recording } from "@/types";

// Studio: pick a recording from the title-bar folder menu and play it. Effects
// (background/framing/zoom) come later, one quality-checked feature at a time.

export function StudioEditor() {
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const playerRef = useRef<StudioPlayerHandle>(null);
  // Loop region from the timeline, in video-relative ms (null = no loop).
  const [loop, setLoop] = useState<LoopRegion | null>(null);
  // Recording id armed for delete (first click); a second click confirms.
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  // The player portals its transport controls into this bottom-panel node, so
  // the top stays just the clip and the bottom holds the controls + events.
  const [controlsHost, setControlsHost] = useState<HTMLDivElement | null>(null);
  // Settings view (capture/theme/permissions), toggled by the title-bar gear.
  const [showSettings, setShowSettings] = useState(false);

  const load = useCallback(async () => {
    try {
      const recs = await invoke<Recording[]>("load_recordings");
      // Only video recordings are playable here; newest first (id = ms timestamp).
      const withVideo = recs.filter((r) => r.video).sort((a, b) => (b.id > a.id ? 1 : -1));
      logEvent("info", "studio", "recordings_loaded", {
        fields: {
          count: recs.length,
          videoCount: withVideo.length,
          firstPlayableId: withVideo[0]?.id,
        },
      });
      setRecordings(withVideo);
      setSelectedId((prev) =>
        prev && withVideo.some((r) => r.id === prev) ? prev : (withVideo[0]?.id ?? null),
      );
    } catch (e) {
      logEvent("error", "studio", "load_recordings_failed", { error: e });
    } finally {
      setLoaded(true);
    }
  }, []);

  // Load on mount, and refresh whenever the window regains focus so a recording
  // made in the main window shows up without a restart.
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [load]);

  const selected = useMemo(
    () => recordings.find((r) => r.id === selectedId) ?? null,
    [recordings, selectedId],
  );
  const title = selected ? recordingTitle(selected) : "Studio";
  const { url } = useVideoAssetUrl(selected?.video);
  const sync = usePlaybackSync({ events: selected?.events ?? [], video: selected?.video });

  // Clear the loop and any armed delete when switching clips.
  useEffect(() => {
    setLoop(null);
    setConfirmDeleteId(null);
  }, [selectedId]);

  const handleDelete = useCallback(
    async (id: string) => {
      try {
        await invoke("delete_recording", { id });
        await load(); // load() reselects the first remaining recording if this was selected.
      } catch (e) {
        logEvent("error", "studio", "delete_recording_failed", {
          error: e,
          fields: { recordingId: id },
        });
      }
    },
    [load],
  );

  // Two-click delete — window.confirm isn't reliable in the Tauri webview, so
  // the first click arms the trash (turns red) and the second confirms.
  const handleDeleteClick = (id: string) => {
    if (confirmDeleteId === id) {
      setConfirmDeleteId(null);
      void handleDelete(id);
    } else {
      setConfirmDeleteId(id);
    }
  };

  // Replay runs from the main control panel (focus-safe). Hand it the recording;
  // the main window comes forward with it loaded, ready for the user to play.
  const handleReplay = useCallback((id: string) => {
    void invoke("request_replay", { id }).catch((e) =>
      logEvent("error", "studio", "request_replay_failed", {
        error: e,
        fields: { recordingId: id },
      }),
    );
  }, []);

  // Rename the selected recording inline from the title bar.
  const handleRename = useCallback(
    async (name: string) => {
      if (!selectedId) return;
      try {
        const updated = await invoke<Recording>("update_recording_name", { id: selectedId, name });
        setRecordings((rs) => rs.map((r) => (r.id === updated.id ? updated : r)));
      } catch (e) {
        logEvent("error", "studio", "rename_recording_failed", {
          error: e,
          fields: { recordingId: selectedId },
        });
      }
    },
    [selectedId],
  );

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        borderRadius: 12,
        fontFamily: "system-ui, -apple-system, sans-serif",
        color: "#e5e7eb",
        background: "#0f0f14",
      }}
    >
      <style>{`
        /* Themed scrollbars for the whole studio window (universal selector,
           like the main app's index.css — WKWebView honors ::-webkit-scrollbar
           this way). Lives here in the always-mounted root component. */
        * { scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.18) transparent; }
        *::-webkit-scrollbar { width: 8px; height: 8px; }
        *::-webkit-scrollbar-track { background: transparent; }
        *::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.18); border-radius: 4px; border: 2px solid transparent; background-clip: padding-box; }
        *::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.32); background-clip: padding-box; }
        .studio-gear { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 24px; padding: 0; border: none; border-radius: 6px; background: transparent; color: rgba(255,255,255,0.65); cursor: pointer; transition: background 120ms ease, color 120ms ease; }
        .studio-gear:hover, .studio-gear.active { background: rgba(255,255,255,0.1); color: #fff; }
      `}</style>

      <StudioTitleBar
        title={showSettings ? "Settings" : title}
        editable={!showSettings && !!selected}
        onTitleChange={handleRename}
        left={
          <RecordingsMenu
            recordings={recordings}
            selectedId={selectedId}
            confirmDeleteId={confirmDeleteId}
            onSelect={(id) => {
              setSelectedId(id);
              setShowSettings(false);
            }}
            onDeleteClick={handleDeleteClick}
            onOpen={() => void load()}
          />
        }
        right={
          <button
            type="button"
            className={`studio-gear${showSettings ? " active" : ""}`}
            aria-label="Settings"
            title="Settings"
            aria-pressed={showSettings}
            onClick={() => setShowSettings((s) => !s)}
          >
            <Settings size={15} />
          </button>
        }
      />

      {/* Body — settings view, else top is the clip and bottom is all the events. */}
      <div style={{ flex: 1, minHeight: 0, minWidth: 0, display: "flex", flexDirection: "column" }}>
        {showSettings ? (
          <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 24 }}>
            <div style={{ maxWidth: 560, margin: "0 auto" }}>
              <SettingsTab />
            </div>
          </div>
        ) : selected && url ? (
          <>
            {/* Top: the clip */}
            <div
              style={{
                flex: 1,
                minHeight: 0,
                display: "flex",
                flexDirection: "column",
                padding: 24,
                boxSizing: "border-box",
              }}
            >
              <StudioPlayer
                key={selected.id}
                ref={playerRef}
                src={url}
                fps={selected.video?.fps ?? 30}
                onTimeUpdate={sync.onVideoTime}
                onReplay={() => handleReplay(selected.id)}
                loopRegion={loop ? { a: loop.a / 1000, b: loop.b / 1000 } : null}
                controlsHost={controlsHost}
              />
            </div>
            {/* Bottom: transport controls + all the events */}
            <div
              style={{
                flexShrink: 0,
                padding: "12px 24px 18px",
                borderTop: "1px solid rgba(255,255,255,0.08)",
                background: "rgba(20,20,28,0.55)",
              }}
            >
              <div ref={setControlsHost} style={{ marginBottom: 14 }} />
              <StudioTimeline
                events={selected.events}
                startMs={sync.startMs}
                durationMs={selected.video?.duration_ms ?? 0}
                videoMs={sync.videoTimeMs}
                onSeekSeconds={(s) => playerRef.current?.seek(s)}
                loop={loop}
                onLoopChange={setLoop}
              />
            </div>
          </>
        ) : (
          <div
            style={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 14,
              color: "rgba(255,255,255,0.4)",
              padding: 24,
              textAlign: "center",
            }}
          >
            {!loaded
              ? "Loading…"
              : recordings.length === 0
                ? "No recordings yet. Record one in the main window, then open the folder to pick it."
                : "Select a recording from the folder menu."}
          </div>
        )}
      </div>
    </div>
  );
}
