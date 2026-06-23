import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Trash2 } from "lucide-react";
import type { Recording } from "@/types";
import { useVideoAssetUrl } from "@/hooks/useVideoAssetUrl";

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
  // The video fades in once it can paint, so switching clips reads as a soft
  // crossfade against the dark stage rather than a hard cut to black.
  const [videoReady, setVideoReady] = useState(false);
  const selectedRef = useRef<HTMLDivElement | null>(null);

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
      console.error("load_recordings failed", e);
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

  // Reset the fade and keep the active clip visible in the list on every switch.
  useEffect(() => {
    setVideoReady(false);
    selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  const handleDelete = useCallback(
    async (id: string) => {
      if (!window.confirm("Delete this recording? This cannot be undone.")) return;
      try {
        await invoke("delete_recording", { id });
        await load(); // load() reselects the first remaining recording if this was selected.
      } catch (e) {
        console.error("delete_recording failed", e);
      }
    },
    [load],
  );

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
                  className="rec-del"
                  title="Delete recording"
                  onClick={() => void handleDelete(r.id)}
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
          position: "relative",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
          boxSizing: "border-box",
        }}
      >
        {selected && url ? (
          <video
            key={selected.id}
            src={url}
            controls
            autoPlay
            loop
            onLoadedData={() => setVideoReady(true)}
            style={{
              maxWidth: "100%",
              maxHeight: "100%",
              borderRadius: 8,
              boxShadow: "0 12px 40px rgba(0,0,0,0.5)",
              background: "#000",
              opacity: videoReady ? 1 : 0,
              transition: "opacity 180ms ease",
            }}
          />
        ) : (
          <div style={{ fontSize: 14, color: "rgba(255,255,255,0.4)" }}>
            {loaded ? "Select a recording to play." : "Loading…"}
          </div>
        )}
        {selected && url && !videoReady && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              pointerEvents: "none",
              fontSize: 13,
              color: "rgba(255,255,255,0.5)",
            }}
          >
            Loading…
          </div>
        )}
      </div>
    </div>
  );
}
