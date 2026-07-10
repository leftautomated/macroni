import { useCallback, useEffect, useRef, useState } from "react";
import { AddNodePanel } from "@/components/studio/macros/AddNodePanel";
import { MacroCanvas } from "@/components/studio/macros/MacroCanvas";
import { MacrosMenu } from "@/components/studio/macros/MacrosMenu";
import { MacroToolbar } from "@/components/studio/macros/MacroToolbar";
import type { useMacros } from "@/hooks/useMacros";
import { isLinearChain } from "@/lib/macro-chain";
import { invoke, logEvent, stringifyError } from "@/lib/observability";
import type {
  MacroDoc,
  MacroNode,
  ObservationResult,
  PerceptionTarget,
  Recording,
  Region,
} from "@/types";

export interface MacroEditorProps extends ReturnType<typeof useMacros> {
  recordings: Recording[];
}

function emptyMacro(name: string): MacroDoc {
  return { id: crypto.randomUUID(), name, nodes: [], edges: [], created_at: Date.now() };
}

/**
 * The Macros view. The saved-doc list + run/live state come from `useMacros()`,
 * lifted into StudioEditor (always mounted) so a run in progress — its Stop
 * button, live highlight, runState — survives toggling away from this view;
 * MacroEditor just consumes that as props. Local state here is only
 * `workingDoc` (+ dirty), which the canvas and add-node panel edit freely —
 * nothing reaches the backend until Save; onChange/addNode only ever touch
 * local state and flip `dirty`, matching the rest of the editor's
 * explicit-save model (no autosave).
 */
export function MacroEditor({
  recordings,
  macros,
  save,
  remove,
  run,
  stop,
  runState,
  liveNodeId,
  failed,
  clearFailed,
}: MacroEditorProps) {
  const [workingDoc, setWorkingDoc] = useState<MacroDoc>(() => emptyMacro("Untitled Macro"));
  const [dirty, setDirty] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

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

  const handleSelect = useCallback(
    (id: string) => {
      const found = macros.find((m) => m.id === id);
      if (!found) return;
      handedOffRef.current = true;
      setWorkingDoc(found);
      setDirty(false);
      setConfirmDeleteId(null);
      setRunError(null);
      clearFailed();
    },
    [macros, clearFailed],
  );

  const handleCreate = useCallback(
    (name: string) => {
      handedOffRef.current = true;
      setWorkingDoc(emptyMacro(name));
      setDirty(false);
      setConfirmDeleteId(null);
      setRunError(null);
      clearFailed();
    },
    [clearFailed],
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

  const handleCanvasChange = useCallback((doc: MacroDoc) => {
    setWorkingDoc(doc);
    setDirty(true);
  }, []);

  const handleAddNode = useCallback((node: MacroNode) => {
    setWorkingDoc((doc) => ({ ...doc, nodes: [...doc.nodes, node] }));
    setDirty(true);
  }, []);

  // Capture a newly authored Image (TemplateMatch) target for the Visual Wait
  // panel: save_target crops the reference PNG out of the recording's video
  // at `timestampMs` and rewrites `target.kind.image` to point at it — the
  // panel wraps whatever this returns in a WaitFor node, never the pre-save
  // target (which still has an empty `image`). Errors surface in the same
  // banner as Save/Run and no node gets added (the panel never calls onAdd if
  // this rejects).
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
        setRunError(stringifyError(e));
        throw e;
      }
    },
    [],
  );

  // Sample the average color of a region at a given playhead (for the Visual
  // Wait panel's Color authoring path) — mirrors StudioEditor's own
  // handleSampleColor. Falls back to black on failure (surfaced via the
  // banner) rather than throwing, since the panel always has a color to wrap.
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
        setRunError(stringifyError(e));
        return [0, 0, 0];
      }
    },
    [],
  );

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
        setRunError(stringifyError(e));
      });
  }, [save, workingDoc]);

  const valid = isLinearChain(workingDoc);
  // run_macro loads the STORED doc by id — an unsaved draft doesn't exist
  // there yet, and a dirty saved macro would run its stale stored version.
  // Gate Run on the working doc actually being the persisted one.
  const isSaved = macros.some((m) => m.id === workingDoc.id);
  const needsSave = dirty || !isSaved;
  const runDisabledReason = needsSave ? "Save before running." : null;

  const handleRun = useCallback(() => {
    if (!valid || needsSave || runState !== "idle") return;
    setRunError(null);
    run(workingDoc.id).catch((e) => {
      logEvent("error", "macros", "run_macro_failed", { error: e, fields: { id: workingDoc.id } });
      // Tauri commands reject with plain strings, not Error objects — route
      // through stringifyError so the real backend reason surfaces instead of
      // collapsing to a generic message.
      const message = stringifyError(e);
      setRunError(message === "Already playing" ? "Stop playback first." : message);
    });
  }, [valid, needsSave, runState, run, workingDoc.id]);

  const handleStop = useCallback(() => {
    stop().catch((e) => {
      logEvent("error", "macros", "stop_macro_failed", { error: e });
      setRunError(stringifyError(e));
    });
  }, [stop]);

  // A deliberate Stop surfaces as a macro-run-failed event with reason
  // "stopped" — show it as neutral status, not a red failure banner/node.
  const isStoppedRun = failed?.reason === "stopped";
  const bannerError =
    runError ?? (failed && !isStoppedRun ? `"${failed.nodeId}" failed: ${failed.reason}` : null);
  const bannerInfo = !runError && isStoppedRun ? "Run stopped." : null;

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "10px 16px",
          borderBottom: "1px solid rgba(255,255,255,0.08)",
        }}
      >
        <MacrosMenu
          macros={macros}
          selectedId={workingDoc.id}
          confirmDeleteId={confirmDeleteId}
          onSelect={handleSelect}
          onCreate={handleCreate}
          onDeleteClick={handleDeleteClick}
        />
        <div style={{ fontSize: 13, fontWeight: 600, color: "#e5e7eb" }}>{workingDoc.name}</div>
      </div>

      <MacroToolbar
        dirty={dirty}
        valid={valid}
        runState={runState}
        runDisabledReason={runDisabledReason}
        onSave={handleSave}
        onRun={handleRun}
        onStop={handleStop}
        error={bannerError}
        info={bannerInfo}
      />

      <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
        <div
          style={{
            width: 260,
            flexShrink: 0,
            padding: 16,
            overflowY: "auto",
            borderRight: "1px solid rgba(255,255,255,0.08)",
          }}
        >
          <AddNodePanel
            recordings={recordings}
            onAdd={handleAddNode}
            captureImageWait={captureImageWait}
            sampleColor={sampleColor}
          />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <MacroCanvas
            doc={workingDoc}
            liveNodeId={liveNodeId}
            failedNodeId={isStoppedRun ? null : (failed?.nodeId ?? null)}
            onChange={handleCanvasChange}
          />
        </div>
      </div>
    </div>
  );
}
