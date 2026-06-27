import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Pause, Play, Repeat, StepBack, StepForward } from "lucide-react";
import { logEvent } from "@/lib/observability";

export interface StudioPlayerHandle {
  seek: (seconds: number) => void;
}

interface StudioPlayerProps {
  src: string;
  fps: number;
  onTimeUpdate: (seconds: number) => void;
  onReplay: () => void;
  /** When set (seconds), playback repeats over [a, b]. */
  loopRegion?: { a: number; b: number } | null;
}

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
  { src, fps, onTimeUpdate, onReplay, loopRegion },
  ref,
) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [loop, setLoop] = useState(true);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

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

  const stepFrame = useCallback(
    (dir: number) => {
      const v = videoRef.current;
      if (!v) return;
      v.pause();
      const dt = 1 / Math.max(1, fps);
      v.currentTime = Math.min(v.duration || 0, Math.max(0, v.currentTime + dir * dt));
    },
    [fps],
  );

  const changeSpeed = useCallback((value: number) => {
    setSpeed(value);
    const v = videoRef.current;
    if (v) v.playbackRate = value;
  }, []);

  const toggleLoop = useCallback(() => setLoop((l) => !l), []);

  const speedFrac = (speed - SPEED_MIN) / (SPEED_MAX - SPEED_MIN);

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        gap: 12,
        background: "#0f0f14",
      }}
    >
      <style>{`
          .sp-btn { display:inline-flex; align-items:center; justify-content:center; border:none; background:transparent; color:#cbd5e1; border-radius:6px; padding:6px; cursor:pointer; transition: background 120ms ease, color 120ms ease; }
          .sp-btn:hover { background: rgba(255,255,255,0.08); color:#fff; }
          .sp-btn.on { color:#a5b4fc; }
          /* Emphasized, circular play/pause in the center — the primary action. */
          .sp-play { display:inline-flex; align-items:center; justify-content:center; width:38px; height:38px; border-radius:50%; border:1px solid rgba(255,255,255,0.25); background:transparent; color:#fff; cursor:pointer; transition: background 120ms ease, border-color 120ms ease; }
          .sp-play:hover { background: rgba(255,255,255,0.12); border-color: rgba(255,255,255,0.5); }
          .sp-text { font-size:12px; font-variant-numeric: tabular-nums; color:rgba(255,255,255,0.6); }
          .sp-time { font-size:13px; font-variant-numeric: tabular-nums; color:rgba(255,255,255,0.55); }
          .sp-slider { -webkit-appearance:none; appearance:none; width:84px; height:4px; border-radius:2px; background:rgba(255,255,255,0.18); cursor:pointer; outline:none; }
          .sp-slider::-webkit-slider-thumb { -webkit-appearance:none; appearance:none; width:12px; height:12px; border-radius:50%; background:#a5b4fc; cursor:pointer; transition: background 120ms ease; }
          .sp-slider::-webkit-slider-thumb:hover { background:#c7d2fe; }
          .sp-replay { display:inline-flex; align-items:center; gap:6px; border:1px solid rgba(99,102,241,0.5); background:rgba(99,102,241,0.18); color:#e5e7eb; border-radius:8px; padding:6px 12px; font-size:13px; font-weight:600; cursor:pointer; transition: background 120ms ease, border-color 120ms ease; }
          .sp-replay:hover { background:rgba(99,102,241,0.28); border-color:#6366f1; }
        `}</style>

      <div
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

      {/* Controls — a centered cluster of `current ⏮ ▶ ⏭ total`, with the
          secondary actions (speed/loop left, replay right) at the edges. */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr auto 1fr", alignItems: "center" }}>
        {/* Left: speed slider + loop */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, justifySelf: "start" }}>
          <input
            type="range"
            className="sp-slider"
            style={{
              background: `linear-gradient(to right, #6366f1 ${speedFrac * 100}%, rgba(255,255,255,0.18) ${speedFrac * 100}%)`,
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
            title={loop ? "Looping (click to turn off)" : "Loop off (click to loop)"}
            onClick={toggleLoop}
          >
            <Repeat size={16} />
          </button>
        </div>

        {/* Center: current ⏮ ▶ ⏭ total */}
        <div style={{ display: "flex", alignItems: "center", gap: 16, justifySelf: "center" }}>
          <span className="sp-time">{fmtTime(current)}</span>
          <button
            type="button"
            className="sp-btn"
            title="Step back one frame"
            onClick={() => stepFrame(-1)}
          >
            <StepBack size={18} />
          </button>
          <button
            type="button"
            className="sp-play"
            title={playing ? "Pause" : "Play"}
            onClick={togglePlay}
          >
            {playing ? <Pause size={18} /> : <Play size={18} />}
          </button>
          <button
            type="button"
            className="sp-btn"
            title="Step forward one frame"
            onClick={() => stepFrame(1)}
          >
            <StepForward size={18} />
          </button>
          <span className="sp-time">{fmtTime(duration)}</span>
        </div>

        {/* Right: replay */}
        <div style={{ display: "flex", alignItems: "center", justifySelf: "end" }}>
          <button
            type="button"
            className="sp-replay"
            title="Replay this macro in the control bar"
            onClick={onReplay}
          >
            <Play size={14} /> Replay macro
          </button>
        </div>
      </div>
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
