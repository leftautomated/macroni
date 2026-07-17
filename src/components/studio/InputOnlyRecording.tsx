import { Keyboard, Play, Repeat, VideoOff } from "lucide-react";
import { useState } from "react";
import { formatDuration } from "@/lib/recording-format";
import type { Recording } from "@/types";

interface InputOnlyRecordingProps {
  recording: Recording;
  onReplay: (loopForever: boolean) => void;
}

function eventDuration(recording: Recording) {
  const first = recording.events[0]?.timestamp;
  const last = recording.events[recording.events.length - 1]?.timestamp;
  if (first === undefined || last === undefined) return 0;
  return Math.max(0, last - first);
}

export function InputOnlyRecording({ recording, onReplay }: InputOnlyRecordingProps) {
  const [loop, setLoop] = useState(true);
  const actionCount = recording.events.length;

  return (
    <div className="ior-root">
      <style>{`
        .ior-root {
          flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center;
          padding: 32px; box-sizing: border-box;
        }
        .ior-card {
          width: min(520px, 100%); padding: 36px; box-sizing: border-box; text-align: center;
          border: 1px solid rgba(255,255,255,0.1); border-radius: 16px;
          background: linear-gradient(180deg, rgba(240,205,120,0.07), rgba(17,17,17,0.82));
          box-shadow: 0 24px 60px rgba(0,0,0,0.32);
        }
        .ior-icon {
          position: relative; display: inline-flex; align-items: center; justify-content: center;
          width: 58px; height: 58px; color: #f0cd78; border-radius: 16px;
          border: 1px solid rgba(240,205,120,0.25); background: rgba(240,205,120,0.1);
        }
        .ior-icon-badge {
          position: absolute; right: -7px; bottom: -7px; display: inline-flex;
          align-items: center; justify-content: center; width: 25px; height: 25px;
          color: rgba(255,255,255,0.72); border: 3px solid #12110f; border-radius: 50%;
          background: #242424;
        }
        .ior-kicker {
          margin-top: 20px; color: #f0cd78; font-size: 10px; font-weight: 700;
          letter-spacing: 0.12em;
        }
        .ior-title { margin: 7px 0 0; color: #fff; font-size: 21px; font-weight: 650; }
        .ior-copy {
          max-width: 390px; margin: 10px auto 0; color: rgba(255,255,255,0.5);
          font-size: 13px; line-height: 1.55;
        }
        .ior-stats {
          display: grid; grid-template-columns: 1fr 1fr; gap: 1px; max-width: 280px;
          margin: 24px auto; overflow: hidden; border: 1px solid rgba(255,255,255,0.09);
          border-radius: 10px; background: rgba(255,255,255,0.09);
        }
        .ior-stat { padding: 11px 14px; background: rgba(0,0,0,0.52); }
        .ior-stat-value { color: #fff; font-size: 14px; font-weight: 650; font-variant-numeric: tabular-nums; }
        .ior-stat-label { margin-top: 2px; color: rgba(255,255,255,0.38); font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; }
        .ior-actions { display: flex; align-items: center; justify-content: center; gap: 8px; }
        .ior-loop, .ior-replay {
          display: inline-flex; align-items: center; justify-content: center; gap: 7px;
          height: 34px; border-radius: 8px; cursor: pointer; font-size: 12px; font-weight: 650;
          transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
        }
        .ior-loop {
          width: 36px; padding: 0; color: rgba(255,255,255,0.52);
          border: 1px solid rgba(255,255,255,0.13); background: rgba(255,255,255,0.04);
        }
        .ior-loop:hover { color: #fff; background: rgba(255,255,255,0.08); }
        .ior-loop.on { color: #f0cd78; border-color: rgba(240,205,120,0.36); background: rgba(240,205,120,0.1); }
        .ior-replay {
          padding: 0 15px; color: #f4dda4; border: 1px solid rgba(240,205,120,0.5);
          background: rgba(240,205,120,0.17);
        }
        .ior-replay:hover { border-color: #f0cd78; background: rgba(240,205,120,0.27); }
      `}</style>

      <section className="ior-card" aria-label="Input-only recording">
        <div className="ior-icon" aria-hidden="true">
          <Keyboard size={27} />
          <span className="ior-icon-badge">
            <VideoOff size={12} />
          </span>
        </div>
        <div className="ior-kicker">INPUT-ONLY RECORDING</div>
        <h2 className="ior-title">No screen video</h2>
        <p className="ior-copy">
          Screen video was turned off, but Macroni captured the keyboard and mouse actions. This
          recording can still be replayed normally.
        </p>

        <div className="ior-stats">
          <div className="ior-stat">
            <div className="ior-stat-value">{actionCount}</div>
            <div className="ior-stat-label">Actions</div>
          </div>
          <div className="ior-stat">
            <div className="ior-stat-value">{formatDuration(eventDuration(recording))}</div>
            <div className="ior-stat-label">Duration</div>
          </div>
        </div>

        <div className="ior-actions">
          <button
            type="button"
            className={`ior-loop${loop ? " on" : ""}`}
            aria-label={loop ? "Loop on" : "Loop off"}
            title={loop ? "Looping (click to turn off)" : "Loop off (click to loop)"}
            onClick={() => setLoop((enabled) => !enabled)}
          >
            <Repeat size={15} />
          </button>
          <button type="button" className="ior-replay" onClick={() => onReplay(loop)}>
            <Play size={14} /> Replay macro
          </button>
        </div>
      </section>
    </div>
  );
}
