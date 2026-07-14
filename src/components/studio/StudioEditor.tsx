import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Settings, Workflow } from "lucide-react";
import { SettingsTab } from "@/components/SettingsTab";
import { MacroEditor } from "@/components/studio/macros/MacroEditor";
import { PerceptionPanel } from "@/components/studio/PerceptionPanel";
import { RecordingsMenu } from "@/components/studio/RecordingsMenu";
import { StudioPlayer, type StudioPlayerHandle } from "@/components/studio/StudioPlayer";
import { type LoopRegion, StudioTimeline } from "@/components/studio/StudioTimeline";
import { StudioTitleBar } from "@/components/studio/StudioTitleBar";
import { useMacros } from "@/hooks/useMacros";
import { usePlaybackSync } from "@/hooks/usePlaybackSync";
import { useVideoAssetUrl } from "@/hooks/useVideoAssetUrl";
import { invoke, logEvent } from "@/lib/observability";
import { recordingTitle } from "@/lib/recording-format";
import type { Observation, ObservationResult, PerceptionTarget, Recording, Region } from "@/types";

// Studio: pick a recording from the title-bar folder menu and play it. Effects
// (background/framing/zoom) come later, one quality-checked feature at a time.

// Perception UI (overlay chips, drag-to-author targets, the observations
// panel) is paused pending the annotation-UX redesign — backend collection,
// the Settings toggle, and the perception components themselves are untouched
// and keep their own tests; this just stops the Studio from wiring them up.
const PERCEPTION_STUDIO_UI = false;

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
  // Which body is showing: the player (default), settings (capture/theme/
  // permissions, toggled by the gear), or the macro editor (toggled by the
  // Workflow button). Mutually exclusive, hence one union instead of two bools.
  const [view, setView] = useState<"player" | "settings" | "macros">("player");
  // Lifted (rather than called inside MacroEditor) so a run in progress —
  // its Stop button, live highlight, runState — survives toggling away from
  // the macros view; MacroEditor unmounts on toggle but this doesn't.
  const macrosState = useMacros();

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

  // Perception observations for the selected recording, reloaded on switch.
  // The cancelled flag (same pattern as useVideoAssetUrl) keeps a slow response
  // for a previously selected recording from overwriting the current one's state.
  const [observations, setObservations] = useState<Observation[]>([]);
  useEffect(() => {
    setObservations([]);
    if (!PERCEPTION_STUDIO_UI || !selectedId) return;
    let cancelled = false;
    invoke<Observation[]>("load_observations", { recordingId: selectedId })
      .then((obs) => {
        if (!cancelled) setObservations(obs);
      })
      .catch((e) => {
        if (!cancelled) {
          logEvent("warn", "studio.perception", "load_observations_failed", { error: e });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  // Ticks for the timeline's perception lane — one per observation.
  const perceptionTicks = useMemo(() => {
    if (!PERCEPTION_STUDIO_UI) return [];
    return observations.map((o) => ({
      ms: o.timestamp_ms,
      label:
        o.result.type === "Text" && o.result.spans.length > 0
          ? o.result.spans[0].text.slice(0, 40)
          : "observation",
    }));
  }, [observations]);

  // OCR spans to draw over the frame for the observation nearest the playhead
  // (within 600ms), so pausing near a Text observation reveals its boxes.
  const playheadSpans = useMemo(() => {
    if (!PERCEPTION_STUDIO_UI) return [];
    let best: Observation | null = null;
    for (const o of observations) {
      if (Math.abs(o.timestamp_ms - sync.videoTimeMs) <= 600) {
        if (
          !best ||
          Math.abs(o.timestamp_ms - sync.videoTimeMs) <
            Math.abs(best.timestamp_ms - sync.videoTimeMs)
        ) {
          best = o;
        }
      }
    }
    return best?.result.type === "Text" ? best.result.spans : [];
  }, [observations, sync.videoTimeMs]);

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
  const handleReplay = useCallback((id: string, loopForever: boolean) => {
    void invoke("request_replay", { id, loopForever }).catch((e) =>
      logEvent("error", "studio", "request_replay_failed", {
        error: e,
        fields: { recordingId: id, loopForever },
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

  // Persist a target the user authored via drag-to-select in the player.
  const handleSaveTarget = useCallback(
    async (target: PerceptionTarget, timestampMs: number) => {
      if (!selectedId) return;
      try {
        const updated = await invoke<Recording>("save_target", {
          recordingId: selectedId,
          target,
          timestampMs,
        });
        setRecordings((rs) => rs.map((r) => (r.id === updated.id ? updated : r)));
      } catch (e) {
        logEvent("error", "studio.perception", "save_target_failed", {
          error: e,
          fields: { recordingId: selectedId, targetId: target.id },
        });
      }
    },
    [selectedId],
  );

  // Sample the average color of a region at a given playhead, for the Color
  // target kind — used to fill in `rgb` before the target is saved.
  const handleSampleColor = useCallback(
    async (region: Region, timestampMs: number): Promise<[number, number, number]> => {
      if (!selectedId) return [0, 0, 0];
      try {
        const res = await invoke<ObservationResult>("extract_region", {
          source: { type: "Recording", recording_id: selectedId, timestamp_ms: timestampMs },
          region,
          kind: { type: "ColorSample", rgb: [0, 0, 0], tolerance: 255 },
        });
        return res.type === "Color" ? res.rgb : [0, 0, 0];
      } catch (e) {
        logEvent("error", "studio.perception", "sample_color_failed", {
          error: e,
          fields: { recordingId: selectedId, timestampMs },
        });
        return [0, 0, 0];
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
        color: "#fff",
        background:
          "radial-gradient(circle at 50% -18%, rgba(240,205,120,0.11), transparent 36%), #000",
      }}
    >
      <style>{`
        .studio-gear { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 24px; padding: 0; border: none; border-radius: 6px; background: transparent; color: rgba(255,255,255,0.65); cursor: pointer; transition: background 120ms ease, color 120ms ease; }
        .studio-gear:hover, .studio-gear.active { background: rgba(240,205,120,0.14); color: #f0cd78; }

        /* Custom scrollbar for the settings page — a rounded thumb that floats
           inset from the edge (transparent border + padding-box clip), brighter
           on hover/drag. Overrides the subtle global bar above for this view. */
        .studio-settings-scroll { scrollbar-gutter: stable; }
        .studio-settings-scroll::-webkit-scrollbar { width: 12px; }
        .studio-settings-scroll::-webkit-scrollbar-track { background: transparent; }
        .studio-settings-scroll::-webkit-scrollbar-thumb {
          background: rgba(240,205,120,0.42);
          border-radius: 999px;
          border: 3px solid transparent;
          background-clip: padding-box;
          min-height: 48px;
        }
        .studio-settings-scroll::-webkit-scrollbar-thumb:hover { background: rgba(240,205,120,0.72); background-clip: padding-box; }
        .studio-settings-scroll::-webkit-scrollbar-thumb:active { background: rgba(240,205,120,0.92); background-clip: padding-box; }
      `}</style>

      <StudioTitleBar
        title={view === "settings" ? "Settings" : view === "macros" ? "Macros" : title}
        editable={view === "player" && !!selected}
        onTitleChange={handleRename}
        left={
          view === "macros" ? undefined : (
            <RecordingsMenu
              recordings={recordings}
              selectedId={selectedId}
              confirmDeleteId={confirmDeleteId}
              onSelect={(id) => {
                setSelectedId(id);
                setView("player");
              }}
              onDeleteClick={handleDeleteClick}
              onOpen={() => void load()}
            />
          )
        }
        right={
          <>
            <button
              type="button"
              className={`studio-gear${view === "macros" ? " active" : ""}`}
              aria-label="Macro editor"
              title="Macro editor"
              aria-pressed={view === "macros"}
              onClick={() => setView((v) => (v === "macros" ? "player" : "macros"))}
            >
              <Workflow size={15} />
            </button>
            <button
              type="button"
              className={`studio-gear${view === "settings" ? " active" : ""}`}
              aria-label="Settings"
              title="Settings"
              aria-pressed={view === "settings"}
              onClick={() => setView((v) => (v === "settings" ? "player" : "settings"))}
            >
              <Settings size={15} />
            </button>
          </>
        }
      />

      {/* Body — settings or macros view, else top is the clip and bottom is all the events. */}
      <div style={{ flex: 1, minHeight: 0, minWidth: 0, display: "flex", flexDirection: "column" }}>
        {view === "settings" ? (
          <div
            className="studio-settings-scroll"
            style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "28px 24px 48px" }}
          >
            <div style={{ maxWidth: 600, margin: "0 auto" }}>
              <SettingsTab />
            </div>
          </div>
        ) : view === "macros" ? (
          <MacroEditor recordings={recordings} {...macrosState} />
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
                onReplay={(loopForever) => handleReplay(selected.id, loopForever)}
                loopRegion={loop ? { a: loop.a / 1000, b: loop.b / 1000 } : null}
                controlsHost={controlsHost}
                {...(PERCEPTION_STUDIO_UI
                  ? {
                      targets: selected.targets ?? [],
                      spans: playheadSpans,
                      hasObservations: observations.length > 0,
                      onSaveTarget: handleSaveTarget,
                      onSampleColor: handleSampleColor,
                    }
                  : {})}
              />
            </div>
            {/* Bottom: transport controls + all the events */}
            <div
              style={{
                flexShrink: 0,
                padding: "12px 24px 18px",
                borderTop: "1px solid rgba(255,255,255,0.08)",
                background: "rgba(17,17,17,0.72)",
              }}
            >
              <div ref={setControlsHost} style={{ marginBottom: 14 }} />
              {PERCEPTION_STUDIO_UI && selected.targets && selected.targets.length > 0 && (
                <PerceptionPanel
                  recordingId={selected.id}
                  targets={selected.targets}
                  playheadMs={sync.videoTimeMs}
                  onRecordingUpdate={(rec) =>
                    setRecordings((rs) => rs.map((r) => (r.id === rec.id ? rec : r)))
                  }
                />
              )}
              <StudioTimeline
                events={selected.events}
                startMs={sync.startMs}
                durationMs={selected.video?.duration_ms ?? 0}
                videoMs={sync.videoTimeMs}
                onSeekSeconds={(s) => playerRef.current?.seek(s)}
                loop={loop}
                onLoopChange={setLoop}
                perceptionTicks={PERCEPTION_STUDIO_UI ? perceptionTicks : undefined}
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
