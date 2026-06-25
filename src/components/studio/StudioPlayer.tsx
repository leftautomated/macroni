import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Maximize, Pause, Play, Repeat, StepBack, StepForward } from "lucide-react";

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

// 0.25× lets you step through dense mouse-move runs (~125Hz capture) frame by
// frame — at 1× there are more moves per second than the screen can repaint.
const SPEEDS = [0.25, 0.5, 1, 1.5, 2] as const;

function fmtTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

/**
 * Custom video player for the Studio: native controls off, dark-themed bar with
 * play/pause, frame-accurate stepping, a draggable scrubber, speed, loop, and
 * fullscreen. Exposes `seek()` so the synced event list can jump the video.
 */
export const StudioPlayer = forwardRef<StudioPlayerHandle, StudioPlayerProps>(function StudioPlayer(
  { src, fps, onTimeUpdate, onReplay, loopRegion },
  ref,
) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [speedIdx, setSpeedIdx] = useState(2);
  const [loop, setLoop] = useState(true);
  const [ready, setReady] = useState(false);
  const [dragging, setDragging] = useState(false);
  const rate = SPEEDS[speedIdx];

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

  const cycleSpeed = useCallback(() => {
    const next = (speedIdx + 1) % SPEEDS.length;
    setSpeedIdx(next);
    const v = videoRef.current;
    if (v) v.playbackRate = SPEEDS[next];
  }, [speedIdx]);

  const toggleLoop = useCallback(() => setLoop((l) => !l), []);

  const toggleFullscreen = useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen?.();
  }, []);

  const seekFromClientX = useCallback((clientX: number) => {
    const bar = barRef.current;
    const v = videoRef.current;
    if (!bar || !v?.duration) return;
    const rect = bar.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    v.currentTime = frac * v.duration;
  }, []);

  const frac = duration > 0 ? current / duration : 0;

  return (
    <div
      ref={wrapRef}
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
          .sp-text { font-size:12px; font-variant-numeric: tabular-nums; color:rgba(255,255,255,0.6); }
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
            }
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
            borderRadius: 8,
            boxShadow: "0 12px 40px rgba(0,0,0,0.5)",
            background: "#000",
            opacity: ready ? 1 : 0,
            transition: "opacity 180ms ease",
            cursor: "pointer",
          }}
        />
        {!ready && (
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

      {/* Scrubber */}
      <div
        ref={barRef}
        onPointerDown={(e) => {
          setDragging(true);
          barRef.current?.setPointerCapture(e.pointerId);
          seekFromClientX(e.clientX);
        }}
        onPointerMove={(e) => {
          if (dragging) seekFromClientX(e.clientX);
        }}
        onPointerUp={(e) => {
          setDragging(false);
          barRef.current?.releasePointerCapture(e.pointerId);
        }}
        style={{ height: 14, display: "flex", alignItems: "center", cursor: "pointer" }}
      >
        <div
          style={{
            position: "relative",
            width: "100%",
            height: 5,
            borderRadius: 3,
            background: "rgba(255,255,255,0.12)",
          }}
        >
          <div
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              height: "100%",
              width: `${frac * 100}%`,
              borderRadius: 3,
              background: "#6366f1",
            }}
          />
          <div
            style={{
              position: "absolute",
              left: `${frac * 100}%`,
              top: "50%",
              width: 11,
              height: 11,
              borderRadius: "50%",
              background: "#a5b4fc",
              transform: "translate(-50%,-50%)",
            }}
          />
        </div>
      </div>

      {/* Controls */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <button
          type="button"
          className="sp-btn"
          title={playing ? "Pause" : "Play"}
          onClick={togglePlay}
        >
          {playing ? <Pause size={18} /> : <Play size={18} />}
        </button>
        <button
          type="button"
          className="sp-btn"
          title="Step back one frame"
          onClick={() => stepFrame(-1)}
        >
          <StepBack size={16} />
        </button>
        <button
          type="button"
          className="sp-btn"
          title="Step forward one frame"
          onClick={() => stepFrame(1)}
        >
          <StepForward size={16} />
        </button>
        <span className="sp-text">
          {fmtTime(current)} / {fmtTime(duration)}
        </span>
        <div style={{ flex: 1 }} />
        <button type="button" className="sp-btn" title="Playback speed" onClick={cycleSpeed}>
          <span className="sp-text" style={{ color: "#cbd5e1" }}>
            {rate}×
          </span>
        </button>
        <button
          type="button"
          className={`sp-btn${loop ? " on" : ""}`}
          title={loop ? "Looping (click to turn off)" : "Loop off (click to loop)"}
          onClick={toggleLoop}
        >
          <Repeat size={16} />
        </button>
        <button type="button" className="sp-btn" title="Fullscreen" onClick={toggleFullscreen}>
          <Maximize size={16} />
        </button>
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
  );
});
