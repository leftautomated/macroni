import { Keyboard, Play, Repeat, VideoOff } from "lucide-react";
import { useState } from "react";
import { formatDuration, recordingDuration } from "@/lib/recording-format";
import type { Recording } from "@/types";

interface InputOnlyRecordingProps {
  recording: Recording;
  onReplay: (loopForever: boolean) => void;
}

export function InputOnlyRecording({ recording, onReplay }: InputOnlyRecordingProps) {
  const [loop, setLoop] = useState(true);
  const actionCount = recording.events.length;

  return (
    <div className="ior-root">
      <style>{`
        .ior-root {
          flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center;
          box-sizing: border-box;
        }
        .ior-card {
          width: 100%; height: 100%; min-height: 150px; box-sizing: border-box;
          display: flex; flex-direction: column; align-items: center; justify-content: center;
          padding: 24px; text-align: center; border: 1px solid rgba(255,255,255,0.08);
          border-radius: 12px; background: rgba(17,17,17,0.58);
        }
        .ior-icon {
          position: relative; display: inline-flex; align-items: center; justify-content: center;
          width: 48px; height: 48px; color: #f0cd78; border-radius: 13px;
          border: 1px solid rgba(240,205,120,0.25); background: rgba(240,205,120,0.1);
        }
        .ior-icon-badge {
          position: absolute; right: -7px; bottom: -7px; display: inline-flex;
          align-items: center; justify-content: center; width: 25px; height: 25px;
          color: rgba(255,255,255,0.72); border: 3px solid #12110f; border-radius: 50%;
          background: #242424;
        }
        .ior-title { margin: 14px 0 0; color: #fff; font-size: 16px; font-weight: 650; }
        .ior-copy {
          margin: 6px auto 0; color: rgba(255,255,255,0.45); font-size: 12px;
          line-height: 1.45;
        }
        .ior-actions { display: flex; align-items: center; justify-content: center; gap: 8px; margin-top: 16px; }
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
        <h2 className="ior-title">Input-only recording</h2>
        <p className="ior-copy">
          No screen video was captured · {actionCount} {actionCount === 1 ? "action" : "actions"} ·{" "}
          {formatDuration(recordingDuration(recording))}
        </p>

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
