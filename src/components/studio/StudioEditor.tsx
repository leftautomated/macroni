import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Settings, Workflow } from "lucide-react";
import { SettingsTab } from "@/components/SettingsTab";
import { InputOnlyRecording } from "@/components/studio/InputOnlyRecording";
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
import { recordingDuration, recordingTitle } from "@/lib/recording-format";
import { fullTrim, projectWithTrim, trimFromProject, type TrimRange } from "@/lib/recording-trim";
import { publishReplaySelection } from "@/lib/replay-selection";
import type { Observation, ObservationResult, PerceptionTarget, Recording, Region } from "@/types";
import { defaultProjectDoc, type ProjectDoc } from "@/types/project";

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
  const knownRecordingIdsRef = useRef<Set<string>>(new Set());
  const hasLoadedRecordingsRef = useRef(false);
  const playerRef = useRef<StudioPlayerHandle>(null);
  // Loop region from the timeline, in video-relative ms (null = no loop).
  const [loop, setLoop] = useState<LoopRegion | null>(null);
  const [project, setProject] = useState<ProjectDoc | null>(null);
  const [projectRecordingId, setProjectRecordingId] = useState<string | null>(null);
  const [trim, setTrim] = useState<TrimRange>({ a: 0, b: 0 });
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
      const newestFirst = recs.sort((a, b) => b.created_at - a.created_at);
      const newestAdded = hasLoadedRecordingsRef.current
        ? newestFirst.find((recording) => !knownRecordingIdsRef.current.has(recording.id))
        : newestFirst[0];

      knownRecordingIdsRef.current = new Set(newestFirst.map((recording) => recording.id));
      hasLoadedRecordingsRef.current = true;
      logEvent("info", "studio", "recordings_loaded", {
        fields: {
          count: recs.length,
          videoCount: recs.filter((recording) => recording.video).length,
          firstSelectedId: newestFirst[0]?.id,
          newRecordingId: newestAdded?.id,
        },
      });
      setRecordings(newestFirst);
      setSelectedId((prev) =>
        newestAdded
          ? newestAdded.id
          : prev && newestFirst.some((recording) => recording.id === prev)
            ? prev
            : (newestFirst[0]?.id ?? null),
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

  // The control bar owns OS-level input playback. Keep its Play target synced
  // without routing through Tauri's webview manager during startup. A global
  // Tauri event here can deadlock while the sibling webview is still loading.
  useEffect(() => {
    if (!selected) return;
    publishReplaySelection(selected.id);
  }, [selected]);

  const title = selected ? recordingTitle(selected) : "Studio";
  const { url } = useVideoAssetUrl(selected?.video);
  const sync = usePlaybackSync({ events: selected?.events ?? [], video: selected?.video });
  const durationMs = selected ? recordingDuration(selected) : 0;
  const isProjectReady = !!selected && projectRecordingId === selected.id;
  const effectiveTrim = isProjectReady ? trim : fullTrim(durationMs);

  useEffect(() => {
    setProject(null);
    setProjectRecordingId(null);
    setTrim(fullTrim(durationMs));
    if (!selected) return;
    let cancelled = false;
    invoke<ProjectDoc>("studio_load_project", { recordingId: selected.id })
      .then((doc) => {
        if (cancelled) return;
        const loaded = doc ?? defaultProjectDoc(selected.video?.path);
        setProject(loaded);
        setProjectRecordingId(selected.id);
        setTrim(trimFromProject(loaded, durationMs));
      })
      .catch((e) => {
        if (cancelled) return;
        logEvent("error", "studio", "load_project_failed", {
          error: e,
          fields: { recordingId: selected.id },
        });
        setProject(defaultProjectDoc(selected.video?.path));
        setProjectRecordingId(selected.id);
      });
    return () => {
      cancelled = true;
    };
  }, [selected, durationMs]);

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

  const handleTrimCommit = useCallback(
    (next: TrimRange) => {
      if (!selected) return;
      const base = isProjectReady && project ? project : defaultProjectDoc(selected.video?.path);
      const updated = projectWithTrim(base, next, durationMs);
      setProject(updated);
      setTrim(trimFromProject(updated, durationMs));
      void invoke("studio_save_project", { recordingId: selected.id, doc: updated }).catch((e) =>
        logEvent("error", "studio", "save_trim_failed", {
          error: e,
          fields: { recordingId: selected.id, startMs: next.a, endMs: next.b },
        }),
      );
    },
    [durationMs, isProjectReady, project, selected],
  );

  const handleTrimChange = useCallback((next: TrimRange) => {
    setLoop(null);
    setTrim(next);
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
        color: "var(--studio-text)",
        background:
          "radial-gradient(circle at 50% -18%, var(--studio-glow), transparent 36%), var(--studio-bg)",
      }}
    >
      <style>{`
        .studio-gear { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 24px; padding: 0; border: 1px solid transparent; border-radius: 6px; background: transparent; color: var(--studio-text-muted); cursor: pointer; transition: background 120ms ease, border-color 120ms ease, color 120ms ease; }
        .studio-gear:hover, .studio-gear.active { background: var(--studio-accent-soft); color: var(--studio-accent); }

        /* Custom scrollbar for the settings page — a rounded thumb that floats
           inset from the edge (transparent border + padding-box clip), brighter
           on hover/drag. Overrides the subtle global bar above for this view. */
        .studio-settings-scroll { scrollbar-gutter: stable; }
        .studio-settings-scroll::-webkit-scrollbar { width: 12px; }
        .studio-settings-scroll::-webkit-scrollbar-track { background: transparent; }
        .studio-settings-scroll::-webkit-scrollbar-thumb {
          background: var(--studio-scrollbar);
          border-radius: 999px;
          border: 3px solid transparent;
          background-clip: padding-box;
          min-height: 48px;
        }
        .studio-settings-scroll::-webkit-scrollbar-thumb:hover { background: var(--studio-scrollbar-hover); background-clip: padding-box; }
        .studio-settings-scroll::-webkit-scrollbar-thumb:active { background: var(--studio-scrollbar-active); background-clip: padding-box; }
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
        ) : selected && (!selected.video || url) ? (
          <>
            {/* Top: the clip, or a restrained placeholder when video capture was off. */}
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
              {selected.video && url ? (
                <StudioPlayer
                  key={selected.id}
                  ref={playerRef}
                  src={url}
                  fps={selected.video.fps}
                  onTimeUpdate={sync.onVideoTime}
                  showReplay={false}
                  loopRegion={loop ? { a: loop.a / 1000, b: loop.b / 1000 } : null}
                  trimRegion={{ a: effectiveTrim.a / 1000, b: effectiveTrim.b / 1000 }}
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
              ) : (
                <InputOnlyRecording key={selected.id} recording={selected} showReplay={false} />
              )}
            </div>
            {/* Bottom: transport controls + all the events */}
            <div
              style={{
                flexShrink: 0,
                padding: "12px 24px 18px",
                borderTop: "1px solid var(--studio-border)",
                background: "color-mix(in srgb, var(--studio-surface) 88%, transparent)",
              }}
            >
              {selected.video && <div ref={setControlsHost} style={{ marginBottom: 14 }} />}
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
                durationMs={durationMs}
                videoMs={sync.videoTimeMs}
                onSeekSeconds={(s) =>
                  selected.video ? playerRef.current?.seek(s) : sync.onVideoTime(s)
                }
                loop={loop}
                onLoopChange={setLoop}
                trim={isProjectReady ? trim : undefined}
                clipRate={selected.playback_speed}
                onTrimChange={handleTrimChange}
                onTrimCommit={handleTrimCommit}
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
              color: "var(--studio-text-subtle)",
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
