import type React from "react";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Pause, Play, Repeat, SkipBack, SkipForward } from "lucide-react";
import { CreateTargetPopover, type KindOption } from "@/components/studio/CreateTargetPopover";
import { PerceptionOverlay } from "@/components/studio/PerceptionOverlay";
import { logEvent } from "@/lib/observability";
import { videoDisplayRect } from "@/lib/video-rect";
import type { PerceptionTarget, Region, TargetKind, TextSpan } from "@/types";

export interface StudioPlayerHandle {
  seek: (seconds: number) => void;
}

interface StudioPlayerProps {
  src: string;
  fps: number;
  onTimeUpdate: (seconds: number) => void;
  onReplay: (loopForever: boolean) => void;
  /** When set (seconds), playback repeats over [a, b]. */
  loopRegion?: { a: number; b: number } | null;
  /** Where to render the transport controls. Defaults to inline below the video. */
  controlsHost?: HTMLElement | null;
  /** Show the "Replay macro" button (OS-level replay of the recording).
   * Contexts where replay is meaningless — the macro authoring dock — pass
   * false. Defaults to true. */
  showReplay?: boolean;
  /** Perception targets to draw as labeled boxes over the video. */
  targets?: PerceptionTarget[];
  /** OCR text spans to draw as thin boxes over the video. */
  spans?: TextSpan[];
  /**
   * Whether this recording has a continuous-OCR timeline at all — the Text
   * layer chip shows based on this, not on `spans` (which come and go with
   * the playhead).
   */
  hasObservations?: boolean;
  /** Persist a newly authored target at the given playhead. */
  onSaveTarget?: (target: PerceptionTarget, timestampMs: number) => Promise<void>;
  /** Sample the average color of a region at the given playhead. */
  onSampleColor?: (region: Region, timestampMs: number) => Promise<[number, number, number]>;
  /** Which kind buttons the authoring popover offers — defaults to all three
   * (Text/Image/Color). Callers with a narrower authoring context (e.g. the
   * macro Visual Wait mode, which has its own Text form) pass a subset. */
  popoverKinds?: KindOption[];
}

/**
 * Perception overlay layers the player can draw. Visual-only toggles — hiding
 * a layer never disables drag-to-select authoring. Extend this list as new
 * overlay kinds arrive (template matches, color samples, audio lanes).
 */
type PerceptionLayerKey = "targets" | "text";

const OVERLAY_LAYERS: Array<{ key: PerceptionLayerKey; label: string; color: string }> = [
  { key: "targets", label: "Targets", color: "#f0cd78" },
  { key: "text", label: "Text", color: "#f4dda4" },
];

/** Clamped fractional (0..1) position of a client point within a rect. */
function fractionalPoint(clientX: number, clientY: number, r: DOMRect) {
  return {
    x: Math.min(1, Math.max(0, (clientX - r.left) / r.width)),
    y: Math.min(1, Math.max(0, (clientY - r.top) / r.height)),
  };
}

/** Min/abs bounding region (fractional) between two client points against `el`. */
function regionFromPoints(
  startX: number,
  startY: number,
  curX: number,
  curY: number,
  el: HTMLElement,
): Region {
  const r = el.getBoundingClientRect();
  const start = fractionalPoint(startX, startY, r);
  const cur = fractionalPoint(curX, curY, r);
  return {
    x: Math.min(start.x, cur.x),
    y: Math.min(start.y, cur.y),
    w: Math.abs(cur.x - start.x),
    h: Math.abs(cur.y - start.y),
  };
}

// Pointer movement below this (px) is a click, not a drag — matches the
// threshold StudioTimeline uses for its own drag-to-select.
const DRAG_THRESHOLD_PX = 4;

// Playback-speed slider bounds. 0.25× lets you crawl through dense mouse-move
// runs (~125Hz capture) — at 1× there are more moves per second than the screen
// can repaint. The 0.25 step keeps the values clean (0.25, 0.5, … 2).
const SPEED_MIN = 0.25;
const SPEED_MAX = 2;
const SPEED_STEP = 0.25;

/** Speed label without trailing zeros: 1 → "1×", 1.25 → "1.25×". */
function fmtRate(r: number): string {
  return `${Number.parseFloat(r.toFixed(2))}×`;
}

function fmtTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) return "0:00.00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  const cs = Math.floor((s - Math.floor(s)) * 100);
  return `${m}:${String(sec).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

/**
 * Custom video player for the Studio: native controls off, dark-themed bar with
 * play/pause, frame-accurate stepping, a speed slider, and loop. Scrubbing lives
 * on the events timeline; this exposes `seek()` so the timeline can jump the
 * video, and reports `currentTime` so the timeline's playhead stays in sync.
 */
export const StudioPlayer = forwardRef<StudioPlayerHandle, StudioPlayerProps>(function StudioPlayer(
  {
    src,
    fps,
    onTimeUpdate,
    onReplay,
    loopRegion,
    controlsHost,
    showReplay = true,
    targets,
    spans,
    hasObservations,
    onSaveTarget,
    onSampleColor,
    popoverKinds,
  },
  ref,
) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [loop, setLoop] = useState(true);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [visibleLayers, setVisibleLayers] = useState<Record<PerceptionLayerKey, boolean>>({
    targets: true,
    text: true,
  });
  // Intrinsic video pixel dims (from `onLoadedMetadata`) and the container's
  // displayed box (from `ResizeObserver`) — together they map the video's
  // contain-fit rect so the perception overlay can align to displayed pixels,
  // not intrinsic ones.
  const [intrinsic, setIntrinsic] = useState({ width: 0, height: 0 });
  const [box, setBox] = useState({ width: 0, height: 0 });
  // Drag-to-select target authoring: `dragRef` tracks the in-progress pointer
  // gesture (not state — we don't want the 4px threshold check re-rendering),
  // `selection` is the live dashed-box preview while dragging, and `popover`
  // holds the finished region + where to anchor the CreateTargetPopover card.
  // `wasPlaying` snapshots the pre-gesture play state BEFORE pointerdown
  // pauses the video, so a plain click can still toggle in both directions.
  const dragRef = useRef<{ x: number; y: number; moved: boolean; wasPlaying: boolean } | null>(
    null,
  );
  const [selection, setSelection] = useState<Region | null>(null);
  const [popover, setPopover] = useState<{ region: Region; x: number; y: number } | null>(null);

  useImperativeHandle(
    ref,
    () => ({
      seek(seconds: number) {
        const v = videoRef.current;
        if (v) v.currentTime = seconds;
      },
    }),
    [],
  );

  // Track the container's displayed size so the overlay can compute the
  // video's contain-fit rect. jsdom has no ResizeObserver — guard so existing
  // tests (which don't stub it) keep passing; the overlay just renders a
  // zero-size rect until a real observer is available.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      const r = el.getBoundingClientRect();
      setBox({ width: r.width, height: r.height });
    };
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const rect = videoDisplayRect(box, intrinsic);

  // The <video> `timeupdate` event only fires ~4x/sec — too coarse to highlight
  // fast event bursts (mouse-move drags get skipped). While playing, poll
  // currentTime every animation frame so the synced event list tracks precisely.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const v = videoRef.current;
      if (v) {
        if (loopRegion && v.currentTime >= loopRegion.b) v.currentTime = loopRegion.a;
        setCurrent(v.currentTime);
        onTimeUpdate(v.currentTime);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, onTimeUpdate, loopRegion]);

  useEffect(() => {
    setReady(false);
    setLoadError(null);
    setCurrent(0);
    setDuration(0);

    const timer = window.setTimeout(() => {
      const video = videoRef.current;
      if (!video || video.readyState >= 1) return;
      const message = "Video metadata did not load";
      setLoadError(message);
      logEvent("warn", "studio.video", "load_timeout", {
        fields: {
          readyState: video.readyState,
          networkState: video.networkState,
          srcLength: src.length,
        },
      });
    }, 8_000);

    return () => window.clearTimeout(timer);
  }, [src]);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) void v.play();
    else v.pause();
  }, []);

  // Drag-to-select over the video: down snapshots the play state, then always
  // pauses (so a drag doesn't fight playback) and arms the gesture; move past
  // a 4px threshold starts showing a live selection box; up either resolves a
  // plain click (toggling relative to the PRE-pause state, preserving the old
  // click-to-toggle behavior) or opens the CreateTargetPopover at the release
  // point. `wasPlaying` must be captured before pause() — pointerup's toggle
  // reads it, since by then the video is always paused.
  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      x: e.clientX,
      y: e.clientY,
      moved: false,
      wasPlaying: !(videoRef.current?.paused ?? true),
    };
    videoRef.current?.pause();
  }, []);

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    if (!drag.moved) {
      const dist = Math.hypot(e.clientX - drag.x, e.clientY - drag.y);
      if (dist < DRAG_THRESHOLD_PX) return;
      drag.moved = true;
    }
    setSelection(regionFromPoints(drag.x, drag.y, e.clientX, e.clientY, e.currentTarget));
  }, []);

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      dragRef.current = null;
      e.currentTarget.releasePointerCapture(e.pointerId);
      setSelection(null);
      if (!drag) return;
      if (!drag.moved) {
        // Plain click: toggle against the pre-gesture state. Pointer-down
        // already paused, so a click while playing just stays paused; a click
        // while paused resumes.
        if (!drag.wasPlaying) void videoRef.current?.play();
        return;
      }
      // Drag: stay paused for region selection, open the authoring popover —
      // unless target authoring is unavailable (perception UI paused), in which
      // case the drag is inert and just clears the selection.
      if (!onSaveTarget) return;
      const region = regionFromPoints(drag.x, drag.y, e.clientX, e.clientY, e.currentTarget);
      setPopover({ region, x: e.clientX, y: e.clientY });
    },
    [onSaveTarget],
  );

  const closePopover = useCallback(() => {
    setPopover(null);
    setSelection(null);
  }, []);

  const handlePopoverSave = useCallback(
    async (name: string, kind: TargetKind) => {
      const pending = popover;
      if (!pending) return;
      const tsMs = Math.round(current * 1000);
      try {
        // Sample the color BEFORE building the target — never mutate the
        // popover's own kind object, build the final kind fresh here.
        let finalKind = kind;
        if (kind.type === "ColorSample" && onSampleColor) {
          const rgb = await onSampleColor(pending.region, tsMs);
          finalKind = { type: "ColorSample", rgb, tolerance: 10 };
        }
        const target: PerceptionTarget = {
          id: crypto.randomUUID(),
          name,
          modality: "visual",
          region: pending.region,
          kind: finalKind,
          created_at: Date.now(),
        };
        await onSaveTarget?.(target, tsMs);
      } catch (err) {
        logEvent("error", "studio.perception", "save_target_failed", { error: err });
      } finally {
        closePopover();
      }
    },
    [popover, current, onSampleColor, onSaveTarget, closePopover],
  );

  const jumpToStart = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    v.pause();
    v.currentTime = 0;
  }, []);

  const jumpToEnd = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    v.pause();
    // Land on the last frame, not past the end (which would fire `ended`).
    v.currentTime = Math.max(0, (v.duration || 0) - 1 / Math.max(1, fps));
  }, [fps]);

  const changeSpeed = useCallback((value: number) => {
    setSpeed(value);
    const v = videoRef.current;
    if (v) v.playbackRate = value;
  }, []);

  const toggleLoop = useCallback(() => setLoop((l) => !l), []);

  const speedFrac = (speed - SPEED_MIN) / (SPEED_MAX - SPEED_MIN);

  // The transport — a centered cluster of `current ⏮ ▶ ⏭ total`, with the
  // secondary actions (speed/loop left, replay right) at the edges. Rendered in
  // `controlsHost` (the bottom events panel) when provided, else inline.
  const controls = (
    <div style={{ display: "grid", gridTemplateColumns: "1fr auto 1fr", alignItems: "center" }}>
      {/* Left: speed slider + loop */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, justifySelf: "start" }}>
        <input
          type="range"
          className="sp-slider"
          style={{
            background: `linear-gradient(to right, #f0cd78 ${speedFrac * 100}%, rgba(255,255,255,0.18) ${speedFrac * 100}%)`,
          }}
          min={SPEED_MIN}
          max={SPEED_MAX}
          step={SPEED_STEP}
          value={speed}
          onChange={(e) => changeSpeed(Number(e.target.value))}
          title="Playback speed"
          aria-label="Playback speed"
        />
        <span className="sp-text" style={{ minWidth: 36, color: "#cbd5e1", textAlign: "right" }}>
          {fmtRate(speed)}
        </span>
        <button
          type="button"
          className={`sp-btn${loop ? " on" : ""}`}
          aria-label={loop ? "Loop on" : "Loop off"}
          title={loop ? "Looping (click to turn off)" : "Loop off (click to loop)"}
          onClick={toggleLoop}
        >
          <Repeat size={16} />
        </button>
      </div>

      {/* Center: current ⏮ ▶ ⏭ total */}
      <div style={{ display: "flex", alignItems: "center", gap: 16, justifySelf: "center" }}>
        <span className="sp-time">{fmtTime(current)}</span>
        <button type="button" className="sp-btn" title="Jump to start" onClick={jumpToStart}>
          <SkipBack size={18} />
        </button>
        <button
          type="button"
          className="sp-play"
          title={playing ? "Pause" : "Play"}
          onClick={togglePlay}
        >
          {playing ? <Pause size={18} /> : <Play size={18} />}
        </button>
        <button type="button" className="sp-btn" title="Jump to end" onClick={jumpToEnd}>
          <SkipForward size={18} />
        </button>
        <span className="sp-time">{fmtTime(duration)}</span>
      </div>

      {/* Right: replay (kept as an empty cell when hidden so the center
          cluster stays centered in the 1fr auto 1fr grid) */}
      <div style={{ display: "flex", alignItems: "center", justifySelf: "end" }}>
        {showReplay && (
          <button
            type="button"
            className="sp-replay"
            title="Replay this macro in the control bar"
            onClick={() => onReplay(loop)}
          >
            <Play size={14} /> Replay macro
          </button>
        )}
      </div>
    </div>
  );

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        gap: 12,
        background: "#000",
      }}
    >
      <style>{`
          .sp-btn { display:inline-flex; align-items:center; justify-content:center; border:none; background:transparent; color:#cbd5e1; border-radius:6px; padding:6px; cursor:pointer; transition: background 120ms ease, color 120ms ease; }
          .sp-btn:hover { background: rgba(255,255,255,0.08); color:#fff; }
          .sp-btn.on { color:#f0cd78; }
          /* Emphasized, circular play/pause in the center — the primary action. */
          .sp-play { display:inline-flex; align-items:center; justify-content:center; width:38px; height:38px; border-radius:50%; border:1px solid rgba(255,255,255,0.25); background:transparent; color:#fff; cursor:pointer; transition: background 120ms ease, border-color 120ms ease; }
          .sp-play:hover { background: rgba(240,205,120,0.12); border-color: rgba(240,205,120,0.55); color:#f0cd78; }
          .sp-text { font-size:12px; font-variant-numeric: tabular-nums; color:rgba(255,255,255,0.6); }
          .sp-time { font-size:13px; font-variant-numeric: tabular-nums; color:rgba(255,255,255,0.55); }
          .sp-slider { -webkit-appearance:none; appearance:none; width:84px; height:4px; border-radius:2px; background:rgba(255,255,255,0.18); cursor:pointer; outline:none; }
          .sp-slider::-webkit-slider-thumb { -webkit-appearance:none; appearance:none; width:12px; height:12px; border-radius:50%; background:#f0cd78; cursor:pointer; transition: background 120ms ease; }
          .sp-slider::-webkit-slider-thumb:hover { background:#f4dda4; }
          .sp-replay { display:inline-flex; align-items:center; gap:6px; border:1px solid rgba(240,205,120,0.5); background:rgba(240,205,120,0.18); color:#f4dda4; border-radius:8px; padding:6px 12px; font-size:13px; font-weight:600; cursor:pointer; transition: background 120ms ease, border-color 120ms ease; }
          .sp-replay:hover { background:rgba(240,205,120,0.28); border-color:#f0cd78; }
          .sp-layer { display:inline-flex; align-items:center; gap:6px; border:1px solid rgba(255,255,255,0.14); background:rgba(15,15,20,0.72); color:rgba(255,255,255,0.45); border-radius:999px; padding:3px 10px; font-size:11px; font-weight:600; cursor:pointer; transition: color 120ms ease, border-color 120ms ease; }
          .sp-layer:hover { border-color: rgba(255,255,255,0.3); }
          .sp-layer.on { color:#e5e7eb; }
        `}</style>

      <div
        ref={containerRef}
        style={{
          flex: 1,
          minHeight: 0,
          position: "relative",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <video
          ref={videoRef}
          src={src}
          autoPlay
          loop={loop}
          onClick={togglePlay}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onLoadedMetadata={() => {
            const v = videoRef.current;
            if (v) {
              setDuration(v.duration);
              setReady(true);
              setLoadError(null);
              setIntrinsic({ width: v.videoWidth, height: v.videoHeight });
              logEvent("info", "studio.video", "metadata_loaded", {
                fields: {
                  durationSeconds: Math.round(v.duration * 100) / 100,
                  videoWidth: v.videoWidth,
                  videoHeight: v.videoHeight,
                  fps,
                },
              });
            }
          }}
          onError={() => {
            const v = videoRef.current;
            const code = v?.error?.code ?? 0;
            const message = mediaErrorMessage(code);
            setLoadError(message);
            logEvent("error", "studio.video", "load_failed", {
              message,
              fields: {
                code,
                readyState: v?.readyState,
                networkState: v?.networkState,
                srcLength: src.length,
              },
            });
          }}
          onTimeUpdate={() => {
            const v = videoRef.current;
            if (v) {
              if (loopRegion && v.currentTime >= loopRegion.b) v.currentTime = loopRegion.a;
              setCurrent(v.currentTime);
              onTimeUpdate(v.currentTime);
            }
          }}
          style={{
            maxWidth: "100%",
            maxHeight: "100%",
            opacity: ready ? 1 : 0,
            transition: "opacity 180ms ease",
            cursor: "pointer",
          }}
        />
        <PerceptionOverlay
          rect={rect}
          targets={visibleLayers.targets ? (targets ?? []) : []}
          spans={visibleLayers.text ? (spans ?? []) : []}
        />
        {/* Interaction layer: sits on top of the video at the same displayed
            rect, so plain clicks (no movement) still toggle play, while a
            drag past the 4px threshold selects a region for a new target. */}
        <div
          className="sp-interact"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          style={{
            position: "absolute",
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
            cursor: "crosshair",
            pointerEvents: "auto",
          }}
        >
          {selection && (
            <div
              style={{
                position: "absolute",
                left: `${selection.x * 100}%`,
                top: `${selection.y * 100}%`,
                width: `${selection.w * 100}%`,
                height: `${selection.h * 100}%`,
                boxSizing: "border-box",
                border: "1.5px dashed #f0cd78",
                background: "rgba(240,205,120,0.15)",
                pointerEvents: "none",
              }}
            />
          )}
        </div>
        {/* Overlay layer chips — one per perception layer with content. Sits
            above the interaction layer (later sibling) so clicks land here. */}
        {(() => {
          const available: Record<PerceptionLayerKey, boolean> = {
            targets: (targets?.length ?? 0) > 0,
            text: hasObservations ?? false,
          };
          const chips = OVERLAY_LAYERS.filter((l) => available[l.key]);
          if (chips.length === 0) return null;
          return (
            <div style={{ position: "absolute", top: 10, right: 10, display: "flex", gap: 6 }}>
              {chips.map((layer) => {
                const on = visibleLayers[layer.key];
                return (
                  <button
                    key={layer.key}
                    type="button"
                    className={`sp-layer${on ? " on" : ""}`}
                    aria-pressed={on}
                    aria-label={`${on ? "Hide" : "Show"} ${layer.label} overlay`}
                    title={`${on ? "Hide" : "Show"} the ${layer.label.toLowerCase()} overlay`}
                    onClick={() => setVisibleLayers((v) => ({ ...v, [layer.key]: !on }))}
                  >
                    <span
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: 2,
                        background: layer.color,
                        opacity: on ? 1 : 0.35,
                      }}
                    />
                    {layer.label}
                  </button>
                );
              })}
            </div>
          );
        })()}
        {(!ready || loadError) && (
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
              textAlign: "center",
              padding: 24,
            }}
          >
            {loadError ?? "Loading…"}
          </div>
        )}
      </div>

      {popover && (
        <CreateTargetPopover
          region={popover.region}
          anchor={{ x: popover.x, y: popover.y }}
          defaultName={`Target ${(targets?.length ?? 0) + 1}`}
          kinds={popoverKinds}
          onSave={handlePopoverSave}
          onCancel={closePopover}
        />
      )}

      {controlsHost ? createPortal(controls, controlsHost) : controls}
    </div>
  );
});

function mediaErrorMessage(code: number) {
  switch (code) {
    case 1:
      return "Video loading was aborted.";
    case 2:
      return "Video failed to load from disk.";
    case 3:
      return "Video could not be decoded by the webview.";
    case 4:
      return "Video format or asset URL is not supported by the webview.";
    default:
      return "Video failed to load.";
  }
}
