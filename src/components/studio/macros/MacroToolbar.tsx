import { Play, Save, Square } from "lucide-react";
import type { MacroRunState } from "@/hooks/useMacros";

export interface MacroToolbarProps {
  dirty: boolean;
  valid: boolean;
  runState: MacroRunState;
  onSave: () => void;
  onRun: () => void;
  onStop: () => void;
  /**
   * Extra reason Run is disabled beyond chain-validity/running — e.g. unsaved
   * changes or a doc that hasn't been saved yet. Shown as the Run button's
   * title/hint when set, and forces the button disabled.
   */
  runDisabledReason?: string | null;
}

/**
 * Compact Save / Run / Stop controls for the macro editor header. Save is
 * always available (explicit — nothing autosaves). Run only fires when the
 * canvas is a single linear chain, nothing is currently playing, and (via
 * `runDisabledReason`) the working doc is saved and not dirty; Stop appears
 * alongside it mid-run.
 */
export function MacroToolbar({
  dirty,
  valid,
  runState,
  onSave,
  onRun,
  onStop,
  runDisabledReason,
}: MacroToolbarProps) {
  const running = runState === "running";
  const runDisabled = !valid || running || !!runDisabledReason;
  const runTitle = runDisabledReason ?? "Run";

  return (
    <div className="mt-root">
      <button
        type="button"
        className="mt-btn mt-save"
        onClick={onSave}
        title="Save"
        aria-label={dirty ? "Save unsaved changes" : "Save"}
      >
        <Save size={13} />
        Save
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
  );
}
