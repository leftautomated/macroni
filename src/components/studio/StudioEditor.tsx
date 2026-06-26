import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Trash2 } from "lucide-react";
import { StudioPlayer, type StudioPlayerHandle } from "@/components/studio/StudioPlayer";
import { type LoopRegion, StudioTimeline } from "@/components/studio/StudioTimeline";
import { usePlaybackSync } from "@/hooks/usePlaybackSync";
import { useVideoAssetUrl } from "@/hooks/useVideoAssetUrl";
import { invoke, logEvent } from "@/lib/observability";
import type { Recording } from "@/types";

// Simplest studio: list recordings and play the selected one. Effects
// (background/framing/zoom) come later, one quality-checked feature at a time.

function formatWhen(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export function StudioEditor() {
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const selectedRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<StudioPlayerHandle>(null);
  // Loop region from the timeline, in video-relative ms (null = no loop).
  const [loop, setLoop] = useState<LoopRegion | null>(null);
  // Recording id armed for delete (first click); a second click confirms.
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const recs = await invoke<Recording[]>("load_recordings");
      // Only video recordings are playable here; newest first (id = ms timestamp).
      const withVideo = recs.filter((r) => r.video).sort((a, b) => (b.id > a.id ? 1 : -1));
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
  const { url } = useVideoAssetUrl(selected?.video);
  const sync = usePlaybackSync({ events: selected?.events ?? [], video: selected?.video });

  // Keep the active clip visible in the list, and clear the loop, on switch.
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest" });
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

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        overflow: "hidden",
        display: "flex",
        fontFamily: "system-ui, -apple-system, sans-serif",
        color: "#e5e7eb",
        background: "#0f0f14",
      }}
    >
      <style>{`
        .studio-refresh {
          border: 1px solid rgba(255,255,255,0.15);
          background: transparent;
          color: #cbd5e1;
          border-radius: 6px;
          padding: 2px 8px;
          font-size: 12px;
          cursor: pointer;
          transition: background 120ms ease, border-color 120ms ease;
        }
        .studio-refresh:hover { background: rgba(255,255,255,0.08); border-color: rgba(255,255,255,0.3); }
        .rec-row {
          display: flex;
          align-items: center;
          gap: 4px;
          border: 1px solid transparent;
          border-radius: 8px;
          margin-bottom: 4px;
          padding-right: 6px;
          transition: background 120ms ease, border-color 120ms ease;
        }
        .rec-row:hover { background: rgba(255,255,255,0.05); }
        .rec-row.sel { border-color: #6366f1; background: rgba(99,102,241,0.18); }
        .rec-row.sel:hover { background: rgba(99,102,241,0.22); }
        .rec-select {
          flex: 1;
          min-width: 0;
          text-align: left;
          border: none;
          background: transparent;
          color: inherit;
          border-radius: 8px;
          padding: 10px 12px;
          cursor: pointer;
        }
        .rec-del {
          flex-shrink: 0;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          border: none;
          background: transparent;
          color: rgba(255,255,255,0.4);
          border-radius: 6px;
          padding: 4px;
          cursor: pointer;
          opacity: 0;
          transition: opacity 120ms ease, color 120ms ease, background 120ms ease;
        }
        .rec-row:hover .rec-del,
        .rec-row.sel .rec-del { opacity: 1; }
        .rec-del:hover { color: #f87171; background: rgba(248,113,113,0.14); }
        .rec-del.armed { opacity: 1; color: #f87171; background: rgba(248,113,113,0.22); }
        /* Themed scrollbars for the whole studio window (universal selector,
           like the main app's index.css — WKWebView honors ::-webkit-scrollbar
           this way). Lives here in the always-mounted root component. */
        * { scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.18) transparent; }
        *::-webkit-scrollbar { width: 8px; height: 8px; }
        *::-webkit-scrollbar-track { background: transparent; }
        *::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.18); border-radius: 4px; border: 2px solid transparent; background-clip: padding-box; }
        *::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.32); background-clip: padding-box; }
      `}</style>

      {/* Recordings list */}
      <div
        style={{
          width: 260,
          flexShrink: 0,
          height: "100%",
          display: "flex",
          flexDirection: "column",
          borderRight: "1px solid rgba(255,255,255,0.08)",
          background: "rgba(20,20,28,0.96)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "14px 14px 10px",
          }}
        >
          <span style={{ fontSize: 13, fontWeight: 600, letterSpacing: 0.3 }}>RECORDINGS</span>
          <button
            type="button"
            onClick={() => void load()}
            title="Refresh"
            className="studio-refresh"
          >
            Refresh
          </button>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: "0 8px 8px" }}>
          {loaded && recordings.length === 0 && (
            <div style={{ padding: 14, fontSize: 13, color: "rgba(255,255,255,0.45)" }}>
              No recordings yet. Record one in the main window, then come back.
            </div>
          )}
          {recordings.map((r) => {
            const isSel = r.id === selectedId;
            return (
              <div
                key={r.id}
                ref={isSel ? selectedRef : null}
                className={`rec-row${isSel ? " sel" : ""}`}
              >
                <button type="button" className="rec-select" onClick={() => setSelectedId(r.id)}>
                  <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 2 }}>
                    {r.name && r.name !== "Untitled" ? r.name : formatWhen(r.created_at)}
                  </div>
                  <div style={{ fontSize: 12, color: "rgba(255,255,255,0.5)" }}>
                    {r.video ? formatDuration(r.video.duration_ms) : "—"} · {r.events.length}{" "}
                    actions
                  </div>
                </button>
                <button
                  type="button"
                  className={`rec-del${confirmDeleteId === r.id ? " armed" : ""}`}
                  title={confirmDeleteId === r.id ? "Click again to delete" : "Delete recording"}
                  onClick={() => handleDeleteClick(r.id)}
                >
                  <Trash2 size={15} />
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {/* Player */}
      <div
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
          padding: 24,
          gap: 12,
          boxSizing: "border-box",
        }}
      >
        {selected && url ? (
          <>
            <StudioPlayer
              key={selected.id}
              ref={playerRef}
              src={url}
              fps={selected.video?.fps ?? 30}
              onTimeUpdate={sync.onVideoTime}
              onReplay={() => handleReplay(selected.id)}
              loopRegion={loop ? { a: loop.a / 1000, b: loop.b / 1000 } : null}
            />
            <StudioTimeline
              events={selected.events}
              startMs={sync.startMs}
              durationMs={selected.video?.duration_ms ?? 0}
              videoMs={sync.videoTimeMs}
              onSeekSeconds={(s) => playerRef.current?.seek(s)}
              loop={loop}
              onLoopChange={setLoop}
            />
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
            }}
          >
            {loaded ? "Select a recording to play." : "Loading…"}
          </div>
        )}
      </div>
    </div>
  );
}
