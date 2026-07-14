import { useCallback, useEffect, useRef, useState } from "react";
import { AddNodePanel } from "@/components/studio/macros/AddNodePanel";
import { AuthoringDock } from "@/components/studio/macros/AuthoringDock";
import { MacroCanvas } from "@/components/studio/macros/MacroCanvas";
import { MacrosMenu } from "@/components/studio/macros/MacrosMenu";
import { MacroToolbar } from "@/components/studio/macros/MacroToolbar";
import type { LoopRegion } from "@/components/studio/StudioTimeline";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import type { useMacros } from "@/hooks/useMacros";
import { isLinearChain } from "@/lib/macro-chain";
import { waitNodeFromTarget } from "@/lib/macro-wait";
import { invoke, logEvent } from "@/lib/observability";
import type {
  MacroDoc,
  MacroNode,
  ObservationResult,
  PerceptionTarget,
  Recording,
  Region,
} from "@/types";
import "./macro-editor.css";

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

  // Shared authoring context: which recording the Add Segment / Visual Wait
  // flows operate on, and the segment range dragged on the dock's timeline
  // (video-relative ms). Owned here because the sidebar forms and the
  // AuthoringDock both read and write them.
  const [authoringRecordingId, setAuthoringRecordingId] = useState("");
  const [authoringRange, setAuthoringRange] = useState<LoopRegion | null>(null);
  const authoringRecording =
    recordings.find((r) => r.id === authoringRecordingId && r.video) ?? null;

  const handleSelectRecording = useCallback((id: string) => {
    setAuthoringRecordingId(id);
    setAuthoringRange(null);
  }, []);

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
  // target (which still has an empty `image`). No node gets added if this
  // rejects (the panel never calls onAdd), and the failure is logged.
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

  // Sample the average color of a region at a given playhead (for the Visual
  // Wait panel's Color authoring path) — mirrors StudioEditor's own
  // handleSampleColor. Falls back to black on failure rather than throwing,
  // since the panel always has a color to wrap; the failure is logged.
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

  const handleDockSaveTarget = useCallback(
    async (target: PerceptionTarget, timestampMs: number) => {
      if (!authoringRecording) return;
      if (target.kind.type === "TemplateMatch") {
        const captured = await captureImageWait(authoringRecording.id, target, timestampMs);
        handleAddNode(waitNodeFromTarget(captured));
      } else {
        handleAddNode(waitNodeFromTarget(target));
      }
    },
    [authoringRecording, captureImageWait, handleAddNode],
  );

  const handleDockSampleColor = useCallback(
    (region: Region, timestampMs: number): Promise<[number, number, number]> =>
      authoringRecording
        ? sampleColor(authoringRecording.id, region, timestampMs)
        : Promise.resolve<[number, number, number]>([0, 0, 0]),
    [authoringRecording, sampleColor],
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
  // "stopped" — don't treat that as a failed canvas node.
  const isStoppedRun = failed?.reason === "stopped";

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
            <div className="macro-editor-kicker">Macro Canvas</div>
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
          <ResizablePanel defaultSize={22} minSize={15} maxSize={35}>
            <aside className="macro-editor-sidebar">
              <div className="macro-editor-sidebar-inner">
                <AddNodePanel
                  recordings={recordings}
                  selectedRecordingId={authoringRecordingId}
                  onSelectRecording={handleSelectRecording}
                  range={authoringRange}
                  onRangeChange={setAuthoringRange}
                  onAdd={handleAddNode}
                />
              </div>
            </aside>
          </ResizablePanel>
          <ResizableHandle />
          <ResizablePanel defaultSize={78}>
            <ResizablePanelGroup direction="vertical">
              <ResizablePanel id="macro-canvas" order={1} defaultSize={60} minSize={30}>
                <section className="macro-editor-canvas-pane" aria-label="Macro canvas">
                  <MacroCanvas
                    doc={workingDoc}
                    liveNodeId={liveNodeId}
                    failedNodeId={isStoppedRun ? null : (failed?.nodeId ?? null)}
                    onChange={handleCanvasChange}
                  />
                </section>
              </ResizablePanel>
              {authoringRecording && (
                <>
                  <ResizableHandle />
                  <ResizablePanel id="authoring-dock" order={2} defaultSize={40} minSize={20}>
                    <AuthoringDock
                      recording={authoringRecording}
                      range={authoringRange}
                      onRangeChange={setAuthoringRange}
                      onSaveTarget={handleDockSaveTarget}
                      onSampleColor={handleDockSampleColor}
                    />
                  </ResizablePanel>
                </>
              )}
            </ResizablePanelGroup>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </div>
  );
}
