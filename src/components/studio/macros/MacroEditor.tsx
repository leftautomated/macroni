import { useCallback, useEffect, useRef, useState } from "react";
import { AuthoringDock } from "@/components/studio/macros/AuthoringDock";
import { MacrosMenu } from "@/components/studio/macros/MacrosMenu";
import { MacroToolbar } from "@/components/studio/macros/MacroToolbar";
import { RuleDeck } from "@/components/studio/macros/RuleDeck";
import { TriggerPicker } from "@/components/studio/macros/TriggerPicker";
import type { LoopRegion } from "@/components/studio/StudioTimeline";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import type { useMacros } from "@/hooks/useMacros";
import {
  anchorTicks,
  defaultActionRange,
  isRunnableRulesDoc,
  moveRule,
  playInputsRule,
  removeRule,
  spanTrigger,
  stopRule,
  toggleRule,
  triggerLabel,
} from "@/lib/macro-rules";
import { eventsInRange, segmentBasis } from "@/lib/macro-segment";
import { invoke, logEvent } from "@/lib/observability";
import { fmtMmSs } from "@/lib/time-format";
import type {
  MacroDoc,
  MacroRule,
  ObservationResult,
  PerceptionTarget,
  Recording,
  Region,
  TextSpan,
} from "@/types";
import "./macro-editor.css";

export interface MacroEditorProps extends ReturnType<typeof useMacros> {
  recordings: Recording[];
}

const DEFAULT_POLL_INTERVAL_MS = 250;

function emptyMacro(name: string): MacroDoc {
  return {
    id: crypto.randomUUID(),
    name,
    rules: [],
    poll_interval_ms: DEFAULT_POLL_INTERVAL_MS,
    created_at: Date.now(),
  };
}

/**
 * Draft-rule authoring state. Entered via Add rule (OCR span path) or a
 * drag-authored image/color target; exits on Add or Cancel.
 */
interface RuleDraft {
  anchorMs: number;
  /** null → the trigger picker is up. */
  trigger: PerceptionTarget | null;
  /** null → OCR still in flight. */
  spans: TextSpan[] | null;
  actionType: "PlayInputs" | "Stop";
}

/**
 * The Macros view. The saved-doc list + run/live state come from `useMacros()`,
 * lifted into StudioEditor (always mounted) so a run in progress — its Stop
 * button, live highlight, runState — survives toggling away from this view;
 * MacroEditor just consumes that as props. Local state here is only
 * `workingDoc` (+ dirty) and the in-flight rule draft; nothing reaches the
 * backend until Save, matching the rest of the editor's explicit-save model
 * (no autosave).
 */
export function MacroEditor({
  recordings,
  macros,
  save,
  remove,
  run,
  stop,
  runState,
  liveRuleId,
  failed,
  clearFailed,
}: MacroEditorProps) {
  const [workingDoc, setWorkingDoc] = useState<MacroDoc>(() => emptyMacro("Untitled Macro"));
  const [dirty, setDirty] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // Shared authoring context: which recording the rule flows operate on, and
  // the action range dragged on the dock's timeline (video-relative ms).
  // Owned here because the deck's draft card and the AuthoringDock both read
  // and write them.
  const [authoringRecordingId, setAuthoringRecordingId] = useState("");
  const [authoringRange, setAuthoringRange] = useState<LoopRegion | null>(null);
  const [draft, setDraft] = useState<RuleDraft | null>(null);
  // One-shot seek request consumed by the dock (rule-card click).
  const [pendingSeekMs, setPendingSeekMs] = useState<number | null>(null);
  // Inline capture-failure message on the draft card — there is no toast
  // system, and a silent failure would look like the drag simply did nothing.
  const [draftError, setDraftError] = useState<string | null>(null);
  // Latest dock playhead, so the deck's Add rule anchors where the dock's
  // does. A ref (not state) — this ticks every animation frame while playing
  // and is only ever read on click.
  const playheadMsRef = useRef(0);

  const authoringRecording =
    recordings.find((r) => r.id === authoringRecordingId && r.video) ?? null;

  const handleSelectRecording = useCallback((id: string) => {
    setAuthoringRecordingId(id);
    setAuthoringRange(null);
  }, []);

  // The recording selector lives inside the dock, and the dock only renders
  // once a recording is picked — so default to the first video-bearing one
  // (and re-default if it disappears), or there'd be no way in.
  useEffect(() => {
    if (recordings.some((r) => r.id === authoringRecordingId && r.video)) return;
    const first = recordings.find((r) => r.video);
    if (first) setAuthoringRecordingId(first.id);
  }, [recordings, authoringRecordingId]);

  // The editor always opens onto *something* editable — a throwaway blank
  // draft until the saved list arrives. Once it does, hand off from that
  // draft to the first real macro, but only if the user hasn't started
  // editing it (dirty) and hasn't already picked/created something else.
  const handedOffRef = useRef(false);
  useEffect(() => {
    if (handedOffRef.current || dirty || macros.length === 0) return;
    if (macros.some((m) => m.id === workingDoc.id)) return;
    handedOffRef.current = true;
    setWorkingDoc(macros[0]);
  }, [macros, dirty, workingDoc.id]);

  const handleCancelDraft = useCallback(() => {
    setDraft(null);
    setDraftError(null);
    setAuthoringRange(null);
  }, []);

  const handleSelect = useCallback(
    (id: string) => {
      const found = macros.find((m) => m.id === id);
      if (!found) return;
      handedOffRef.current = true;
      setWorkingDoc(found);
      setDirty(false);
      setConfirmDeleteId(null);
      handleCancelDraft();
      clearFailed();
    },
    [macros, clearFailed, handleCancelDraft],
  );

  const handleCreate = useCallback(
    (name: string) => {
      handedOffRef.current = true;
      setWorkingDoc(emptyMacro(name));
      setDirty(false);
      setConfirmDeleteId(null);
      handleCancelDraft();
      clearFailed();
    },
    [clearFailed, handleCancelDraft],
  );

  const handleDeleteClick = useCallback(
    (id: string) => {
      if (confirmDeleteId !== id) {
        setConfirmDeleteId(id);
        return;
      }
      setConfirmDeleteId(null);
      remove(id)
        .then(() => {
          if (workingDoc.id === id) {
            handedOffRef.current = false;
            setWorkingDoc(emptyMacro("Untitled Macro"));
            setDirty(false);
          }
        })
        .catch((e) => {
          logEvent("error", "macros", "delete_macro_failed", { error: e, fields: { id } });
        });
    },
    [confirmDeleteId, remove, workingDoc.id],
  );

  // Capture a newly authored Image (TemplateMatch) trigger: save_target crops
  // the reference PNG out of the recording's video at `timestampMs` and
  // rewrites `target.kind.image` to point at it — callers must use whatever
  // this returns, never the pre-save target (whose `image` is still empty).
  // Rejects (after logging) so the caller can surface the failure.
  const captureImageWait = useCallback(
    async (
      recordingId: string,
      target: PerceptionTarget,
      timestampMs: number,
    ): Promise<PerceptionTarget> => {
      try {
        const updated = await invoke<Recording>("save_target", {
          recordingId,
          target,
          timestampMs,
        });
        const saved = updated.targets?.find((t) => t.id === target.id);
        if (!saved) {
          throw new Error("save_target response did not include the saved target");
        }
        return saved;
      } catch (e) {
        logEvent("error", "macros", "capture_image_wait_failed", {
          error: e,
          fields: { recordingId, targetId: target.id },
        });
        throw e;
      }
    },
    [],
  );

  // Sample the average color of a region at a given playhead (for the Color
  // trigger authoring path) — mirrors StudioEditor's own handleSampleColor.
  // Falls back to black on failure rather than throwing, since the popover
  // always has a color to wrap; the failure is logged.
  const sampleColor = useCallback(
    async (
      recordingId: string,
      region: Region,
      timestampMs: number,
    ): Promise<[number, number, number]> => {
      try {
        const res = await invoke<ObservationResult>("extract_region", {
          source: { type: "Recording", recording_id: recordingId, timestamp_ms: timestampMs },
          region,
          kind: { type: "ColorSample", rgb: [0, 0, 0], tolerance: 255 },
        });
        return res.type === "Color" ? res.rgb : [0, 0, 0];
      } catch (e) {
        logEvent("error", "macros", "sample_color_failed", {
          error: e,
          fields: { recordingId, timestampMs },
        });
        return [0, 0, 0];
      }
    },
    [],
  );

  // Add rule pressed in the dock (or the deck) at the current playhead: open
  // a draft immediately, then OCR the whole frame so the picker can offer
  // clickable text spans. A failed scan degrades to drag-a-box, never a dead
  // draft.
  const handleStartDraft = useCallback(
    async (timestampMs: number) => {
      if (!authoringRecording) return;
      const anchorMs = Math.round(timestampMs);
      setDraftError(null);
      setDraft({ anchorMs, trigger: null, spans: null, actionType: "PlayInputs" });
      try {
        const res = await invoke<ObservationResult>("extract_region", {
          source: {
            type: "Recording",
            recording_id: authoringRecording.id,
            timestamp_ms: anchorMs,
          },
          region: { x: 0, y: 0, w: 1, h: 1 },
          kind: { type: "TextOcr", expect: null },
        });
        setDraft((d) => (d ? { ...d, spans: res.type === "Text" ? res.spans : [] } : d));
      } catch (e) {
        logEvent("error", "macros", "frame_ocr_failed", { error: e });
        setDraft((d) => (d ? { ...d, spans: [] } : d));
      }
    },
    [authoringRecording],
  );

  const handleDeckAddRule = useCallback(
    () => void handleStartDraft(playheadMsRef.current),
    [handleStartDraft],
  );

  const applyDraftTrigger = useCallback(
    (trigger: PerceptionTarget, anchorMs: number) => {
      setDraft((d) => ({
        anchorMs,
        trigger,
        spans: null,
        actionType: d?.actionType ?? "PlayInputs",
      }));
      if (authoringRecording?.video) {
        setAuthoringRange(
          defaultActionRange(
            workingDoc,
            authoringRecording.id,
            anchorMs,
            authoringRecording.video.duration_ms,
          ),
        );
      }
    },
    [authoringRecording, workingDoc],
  );

  const handlePickSpan = useCallback(
    (span: TextSpan) => {
      if (!draft) return;
      applyDraftTrigger(spanTrigger(span), draft.anchorMs);
    },
    [draft, applyDraftTrigger],
  );

  // Drag-authored image/color trigger — works both mid-draft and as a direct
  // entry point (dragging on the frame with no draft open starts one).
  const handleDockSaveTarget = useCallback(
    async (target: PerceptionTarget, timestampMs: number) => {
      if (!authoringRecording) return;
      const anchorMs = Math.round(timestampMs);
      try {
        const resolved =
          target.kind.type === "TemplateMatch"
            ? await captureImageWait(authoringRecording.id, target, timestampMs)
            : target;
        setDraftError(null);
        applyDraftTrigger(resolved, anchorMs);
      } catch {
        // captureImageWait already logged it — surface it where the user is
        // looking, opening a draft card to hold the message if the drag was
        // the entry point.
        setDraftError("Couldn't capture that — try again");
        setDraft(
          (d) => d ?? { anchorMs, trigger: null, spans: [], actionType: "PlayInputs" as const },
        );
      }
    },
    [authoringRecording, captureImageWait, applyDraftTrigger],
  );

  const handleDockSampleColor = useCallback(
    (region: Region, timestampMs: number): Promise<[number, number, number]> =>
      authoringRecording
        ? sampleColor(authoringRecording.id, region, timestampMs)
        : Promise.resolve<[number, number, number]>([0, 0, 0]),
    [authoringRecording, sampleColor],
  );

  const handleConfirmDraft = useCallback(() => {
    if (!draft?.trigger || !authoringRecording) return;
    let rule: MacroRule;
    if (draft.actionType === "Stop") {
      rule = stopRule(draft.trigger, authoringRecording.id, draft.anchorMs);
    } else {
      if (!authoringRange || authoringRange.b <= authoringRange.a) return;
      rule = playInputsRule(
        draft.trigger,
        authoringRecording,
        draft.anchorMs,
        authoringRange.a,
        authoringRange.b,
      );
    }
    setWorkingDoc((doc) => ({ ...doc, rules: [...doc.rules, rule] }));
    setDirty(true);
    setDraft(null);
    setDraftError(null);
    setAuthoringRange(null);
  }, [draft, authoringRecording, authoringRange]);

  const handleSetDraftAction = useCallback((actionType: "PlayInputs" | "Stop") => {
    setDraft((d) => (d ? { ...d, actionType } : d));
  }, []);

  const handleToggleRule = useCallback((ruleId: string) => {
    setWorkingDoc((doc) => toggleRule(doc, ruleId));
    setDirty(true);
  }, []);

  const handleDeleteRule = useCallback((ruleId: string) => {
    setWorkingDoc((doc) => removeRule(doc, ruleId));
    setDirty(true);
  }, []);

  const handleMoveRule = useCallback((ruleId: string, delta: -1 | 1) => {
    setWorkingDoc((doc) => moveRule(doc, ruleId, delta));
    setDirty(true);
  }, []);

  // Clicking a card scrubs the dock back to where that rule was authored —
  // switching recordings first if it was anchored on a different one — and
  // restores the range its action came from, so the frame on screen is the
  // one the trigger was cut out of.
  const handleSelectRule = useCallback(
    (ruleId: string) => {
      const rule = workingDoc.rules.find((r) => r.id === ruleId);
      if (!rule?.anchor) return;
      if (rule.anchor.recording_id !== authoringRecordingId) {
        setAuthoringRecordingId(rule.anchor.recording_id);
      }
      setPendingSeekMs(rule.anchor.timestamp_ms);
      const prov = rule.action.type === "PlayInputs" ? rule.action.provenance : null;
      setAuthoringRange(prov ? { a: prov.start_ms, b: prov.end_ms } : null);
    },
    [workingDoc, authoringRecordingId],
  );

  const handleSeekConsumed = useCallback(() => setPendingSeekMs(null), []);

  const handleSave = useCallback(() => {
    save(workingDoc)
      .then((resolved) => {
        handedOffRef.current = true;
        setWorkingDoc(resolved);
        setDirty(false);
      })
      .catch((e) => {
        logEvent("error", "macros", "save_macro_failed", {
          error: e,
          fields: { id: workingDoc.id },
        });
      });
  }, [save, workingDoc]);

  const valid = isRunnableRulesDoc(workingDoc);
  // run_macro loads the STORED doc by id — an unsaved draft doesn't exist
  // there yet, and a dirty saved macro would run its stale stored version.
  // Gate Run on the working doc actually being the persisted one.
  const isSaved = macros.some((m) => m.id === workingDoc.id);
  const needsSave = dirty || !isSaved;
  const runDisabledReason = needsSave ? "Save before running." : null;

  const handleRun = useCallback(() => {
    if (!valid || needsSave || runState !== "idle") return;
    run(workingDoc.id).catch((e) => {
      logEvent("error", "macros", "run_macro_failed", { error: e, fields: { id: workingDoc.id } });
    });
  }, [valid, needsSave, runState, run, workingDoc.id]);

  const handleStop = useCallback(() => {
    stop().catch((e) => {
      logEvent("error", "macros", "stop_macro_failed", { error: e });
    });
  }, [stop]);

  // A deliberate Stop surfaces as a macro-run-failed event with reason
  // "stopped" — don't flag a rule card red for that.
  const isStoppedRun = failed?.reason === "stopped";
  const picking = !!draft && draft.trigger === null;

  return (
    <div className="macro-editor-root">
      <div className="macro-editor-header">
        <div className="macro-editor-identity">
          <MacrosMenu
            macros={macros}
            selectedId={workingDoc.id}
            confirmDeleteId={confirmDeleteId}
            onSelect={handleSelect}
            onCreate={handleCreate}
            onDeleteClick={handleDeleteClick}
          />
          <div className="macro-editor-title-group">
            <div className="macro-editor-kicker">Macro Rules</div>
            <div className="macro-editor-title">{workingDoc.name}</div>
          </div>
        </div>
        <MacroToolbar
          dirty={dirty}
          valid={valid}
          runState={runState}
          runDisabledReason={runDisabledReason}
          onSave={handleSave}
          onRun={handleRun}
          onStop={handleStop}
        />
      </div>

      <div className="macro-editor-main">
        <ResizablePanelGroup direction="horizontal">
          <ResizablePanel defaultSize={30} minSize={18} maxSize={45}>
            <aside className="macro-editor-sidebar">
              <div className="macro-editor-sidebar-inner">
                <RuleDeck
                  rules={workingDoc.rules}
                  liveRuleId={liveRuleId}
                  failed={isStoppedRun ? null : failed}
                  running={runState === "running"}
                  draft={
                    draft && (
                      <DraftCard
                        draft={draft}
                        recording={authoringRecording}
                        range={authoringRange}
                        error={draftError}
                        onSetAction={handleSetDraftAction}
                        onConfirm={handleConfirmDraft}
                        onCancel={handleCancelDraft}
                      />
                    )
                  }
                  onAddRule={handleDeckAddRule}
                  onSelect={handleSelectRule}
                  onToggle={handleToggleRule}
                  onDelete={handleDeleteRule}
                  onMove={handleMoveRule}
                />
              </div>
            </aside>
          </ResizablePanel>
          <ResizableHandle />
          <ResizablePanel defaultSize={70}>
            {authoringRecording ? (
              <AuthoringDock
                key={authoringRecording.id}
                recording={authoringRecording}
                recordings={recordings}
                onSelectRecording={handleSelectRecording}
                range={authoringRange}
                onRangeChange={setAuthoringRange}
                anchorTicks={anchorTicks(workingDoc, authoringRecording.id)}
                pendingSeekMs={pendingSeekMs}
                onSeekConsumed={handleSeekConsumed}
                onPlayheadMs={(ms) => {
                  playheadMsRef.current = ms;
                }}
                onAddRule={handleStartDraft}
                picking={picking}
                pickerOverlay={
                  picking && draft ? (
                    <TriggerPicker
                      spans={draft.spans}
                      onPickSpan={handlePickSpan}
                      onCancel={handleCancelDraft}
                    />
                  ) : undefined
                }
                onSaveTarget={handleDockSaveTarget}
                onSampleColor={handleDockSampleColor}
                onCancelDraft={handleCancelDraft}
                hasDraft={!!draft}
              />
            ) : (
              <div className="macro-editor-canvas-pane" />
            )}
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </div>
  );
}

interface DraftCardProps {
  draft: RuleDraft;
  recording: Recording | null;
  range: LoopRegion | null;
  error: string | null;
  onSetAction: (actionType: "PlayInputs" | "Stop") => void;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * The pending rule, pinned at the top of the deck. Before a trigger is picked
 * it is just a hint plus Cancel (the picker itself is over the frame); once
 * one is picked it becomes the "when → then" the rule will be built from.
 */
function DraftCard({
  draft,
  recording,
  range,
  error,
  onSetAction,
  onConfirm,
  onCancel,
}: DraftCardProps) {
  const hasRange = !!range && range.b > range.a;
  const label = draft.trigger ? triggerLabel(draft.trigger) : null;

  if (!draft.trigger) {
    return (
      <div className="rd-draft">
        <div className="rd-draft-when">Pick the trigger on the frame</div>
        {error && <div className="rd-draft-error">{error}</div>}
        <div className="rd-draft-actions">
          <button
            type="button"
            className="rd-draft-btn"
            aria-label="Cancel rule draft"
            onClick={onCancel}
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  const canConfirm = draft.actionType === "Stop" || hasRange;

  return (
    <div className="rd-draft">
      <div className="rd-draft-when">When {label}</div>
      {draft.actionType === "PlayInputs" && hasRange && recording && range && (
        <div className="rd-draft-chip">
          {fmtMmSs(range.a)}–{fmtMmSs(range.b)} ·{" "}
          {eventsInRange(recording.events, segmentBasis(recording), range.a, range.b).length} events
        </div>
      )}
      <div className="rd-draft-toggle">
        <button
          type="button"
          className="rd-draft-mode"
          data-active={draft.actionType === "PlayInputs"}
          aria-pressed={draft.actionType === "PlayInputs"}
          onClick={() => onSetAction("PlayInputs")}
        >
          Play inputs
        </button>
        <button
          type="button"
          className="rd-draft-mode"
          data-active={draft.actionType === "Stop"}
          aria-pressed={draft.actionType === "Stop"}
          onClick={() => onSetAction("Stop")}
        >
          Stop macro
        </button>
      </div>
      {error && <div className="rd-draft-error">{error}</div>}
      <div className="rd-draft-actions">
        <button
          type="button"
          className="rd-draft-btn rd-draft-confirm"
          aria-label={`Add rule: ${label}`}
          disabled={!canConfirm}
          onClick={onConfirm}
        >
          Add rule
        </button>
        <button
          type="button"
          className="rd-draft-btn"
          aria-label="Cancel rule draft"
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
