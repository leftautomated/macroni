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
  /**
   * Optional neutral status message (e.g. after a deliberate Stop) — shares
   * the banner slot with `error` but styled neutrally instead of red. Ignored
   * whenever `error` is also set.
   */
  info?: string | null;
  /**
   * Extra reason Run is disabled beyond chain-validity/running — e.g. unsaved
   * changes or a doc that hasn't been saved yet. Shown as the Run button's
   * title/hint when set, and forces the button disabled.
   */
  runDisabledReason?: string | null;
}

/**
 * Save / Run / Stop strip for the macro editor. Save is always available
 * (explicit — nothing autosaves) and shows a small dot while there are
 * unsaved edits. Run only fires when the canvas is a single linear chain,
 * nothing is currently playing, and (via `runDisabledReason`) the working doc
 * is saved and not dirty; Stop replaces it mid-run.
 */
export function MacroToolbar({
  dirty,
  valid,
  runState,
  onSave,
  onRun,
  onStop,
  error,
  info,
  runDisabledReason,
}: MacroToolbarProps) {
  const running = runState === "running";
  const runDisabled = !valid || running || !!runDisabledReason;
  const runTitle = runDisabledReason ?? "Run";

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
        .mt-banner.info { color: rgba(255,255,255,0.65); background: rgba(255,255,255,0.06); }
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
          disabled={runDisabled}
          title={runTitle}
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
      {info && !error && (
        <div className="mt-banner info" role="status">
          {info}
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
