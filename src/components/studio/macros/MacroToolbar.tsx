import { Play, Save, Square } from "lucide-react";
import type { MacroRunState } from "@/hooks/useMacros";

export interface MacroToolbarProps {
  dirty: boolean;
  valid: boolean;
  runState: MacroRunState;
  onSave: () => void;
  onRun: () => void;
  onStop: () => void;
  /** Optional inline error (save/run failure) surfaced next to the buttons. */
  error?: string | null;
}

/**
 * Save / Run / Stop strip for the macro editor. Save is always available
 * (explicit — nothing autosaves) and shows a small dot while there are
 * unsaved edits. Run only fires when the canvas is a single linear chain and
 * nothing is currently playing; Stop replaces it mid-run.
 */
export function MacroToolbar({
  dirty,
  valid,
  runState,
  onSave,
  onRun,
  onStop,
  error,
}: MacroToolbarProps) {
  const running = runState === "running";

  return (
    <div className="mt-root">
      <style>{`
        .mt-root { display: flex; flex-direction: column; gap: 8px; padding: 10px 16px; border-bottom: 1px solid rgba(255,255,255,0.08); }
        .mt-row { display: flex; align-items: center; gap: 8px; }
        .mt-btn {
          display: inline-flex; align-items: center; gap: 6px;
          border: 1px solid rgba(255,255,255,0.14); background: rgba(255,255,255,0.06);
          color: #e5e7eb; border-radius: 6px; padding: 6px 12px; font-size: 12px; font-weight: 600;
          cursor: pointer; transition: background 120ms ease, border-color 120ms ease;
        }
        .mt-btn:hover:not(:disabled) { background: rgba(255,255,255,0.12); }
        .mt-btn:disabled { opacity: 0.4; cursor: default; }
        .mt-save { position: relative; }
        .mt-dirty-dot {
          width: 6px; height: 6px; border-radius: 50%; background: #f59e0b; display: inline-block;
        }
        .mt-run { border-color: rgba(34,197,94,0.5); background: rgba(34,197,94,0.16); }
        .mt-run:hover:not(:disabled) { background: rgba(34,197,94,0.26); }
        .mt-stop { border-color: rgba(248,113,113,0.5); background: rgba(248,113,113,0.16); }
        .mt-stop:hover:not(:disabled) { background: rgba(248,113,113,0.26); }
        .mt-banner {
          font-size: 12px; border-radius: 6px; padding: 6px 10px;
        }
        .mt-banner.warn { color: #fbbf24; background: rgba(251,191,36,0.1); }
        .mt-banner.error { color: #f87171; background: rgba(248,113,113,0.1); }
      `}</style>

      <div className="mt-row">
        <button type="button" className="mt-btn mt-save" onClick={onSave} title="Save">
          <Save size={13} />
          Save
          {dirty && <span className="mt-dirty-dot" role="status" aria-label="unsaved changes" />}
        </button>
        <button
          type="button"
          className="mt-btn mt-run"
          onClick={onRun}
          disabled={!valid || running}
          title="Run"
        >
          <Play size={13} />
          Run
        </button>
        {running && (
          <button type="button" className="mt-btn mt-stop" onClick={onStop} title="Stop">
            <Square size={13} />
            Stop
          </button>
        )}
      </div>

      {!valid && (
        <div className="mt-banner warn" role="status">
          Connect the nodes into a single chain (no branches, no cycles) to run this macro.
        </div>
      )}
      {error && (
        <div className="mt-banner error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
