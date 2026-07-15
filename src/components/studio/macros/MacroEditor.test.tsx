import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  InputEventType,
  type InputEvent,
  type MacroDoc,
  type MacroNode,
  type Recording,
} from "@/types";

type Listener = (event: { payload: unknown }) => void | Promise<void>;

const state = vi.hoisted(() => ({
  listeners: new Map<string, Listener>(),
}));

// In-memory backend the mocked Tauri commands talk to. `rejectStop`/`rejectRun`
// let a single test force stop_macro/run_macro to fail without leaking into
// the others. Real Tauri commands reject with plain strings (not Error
// objects), so `rejectRun` is thrown as-is to exercise that path.
const fake = {
  macros: [] as MacroDoc[],
  rejectStop: null as string | null,
  rejectRun: null as string | null,
};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    switch (cmd) {
      case "load_macros":
        return [...fake.macros];
      case "save_macro": {
        const doc = args?.doc as MacroDoc;
        const idx = fake.macros.findIndex((m) => m.id === doc.id);
        if (idx >= 0) fake.macros[idx] = doc;
        else fake.macros.push(doc);
        return doc;
      }
      case "delete_macro": {
        fake.macros = fake.macros.filter((m) => m.id !== args?.id);
        return undefined;
      }
      case "run_macro":
        if (fake.rejectRun !== null) {
          const reason = fake.rejectRun;
          fake.rejectRun = null;
          throw reason;
        }
        return undefined;
      case "stop_macro":
        if (fake.rejectStop) throw new Error(fake.rejectStop);
        return undefined;
      case "save_target": {
        const target = args?.target as { id: string; kind: Record<string, unknown> };
        return {
          id: args?.recordingId,
          targets: [{ ...target, kind: { ...target.kind, image: "targets/rec-1/t-img.png" } }],
        };
      }
      default:
        return undefined;
    }
  }),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: Listener) => {
    state.listeners.set(event, handler);
    return () => state.listeners.delete(event);
  }),
}));

// The real MacroCanvas renders react-flow, which isn't exercised under jsdom
// here — a stub exposes just enough surface (node count, the failed-node id,
// and a button that fires onChange) to test MacroEditor's dirty/save/run-state
// wiring without it.
vi.mock("@/components/studio/macros/MacroCanvas", () => ({
  MacroCanvas: ({
    doc,
    onChange,
    failedNodeId,
  }: {
    doc: MacroDoc;
    onChange: (doc: MacroDoc) => void;
    failedNodeId?: string | null;
  }) => (
    <div>
      <div>canvas: {doc.nodes.length} node(s)</div>
      <div>failed node: {failedNodeId ?? "none"}</div>
      <div>
        segment events:{" "}
        {doc.nodes[0]?.kind?.type === "Segment" ? doc.nodes[0].kind.events.length : "n/a"}
      </div>
      <button
        type="button"
        onClick={() => onChange({ ...doc, nodes: doc.nodes.map((n) => ({ ...n, x: n.x + 1 })) })}
      >
        Simulate drag
      </button>
    </div>
  ),
}));

// The real AuthoringDock renders StudioPlayer/StudioTimeline (video, drag
// math) — covered by its own test file. Here a stub stands in for "the user
// dragged a range / saved a target in the dock" so the shared-state wiring
// through MacroEditor is what's under test.
vi.mock("@/components/studio/macros/AuthoringDock", () => ({
  AuthoringDock: ({
    onRangeChange,
    onSaveTarget,
    onAddSegment,
  }: {
    onRangeChange: (r: { a: number; b: number } | null) => void;
    onSaveTarget: (target: unknown, timestampMs: number) => Promise<void>;
    onAddSegment: () => void;
  }) => (
    <div data-testid="authoring-dock">
      <button type="button" onClick={() => onRangeChange({ a: 2000, b: 4000 })}>
        Simulate dock range
      </button>
      <button
        type="button"
        onClick={() =>
          onSaveTarget(
            {
              id: "t-img",
              name: "Target",
              modality: "visual",
              region: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
              kind: { type: "TemplateMatch", image: "", threshold: 0.8, source_px: [0, 0] },
              created_at: 1,
            },
            4200,
          )
        }
      >
        Simulate dock image save
      </button>
      <button type="button" onClick={() => onAddSegment()}>
        Simulate dock add segment
      </button>
    </div>
  ),
}));

import { MacroEditor } from "@/components/studio/macros/MacroEditor";
import { useMacros } from "@/hooks/useMacros";

const recordings: Recording[] = [];

function mkEvent(key: string, timestamp: number): InputEvent {
  return { type: InputEventType.KeyPress, key, timestamp };
}

const recordingWithVideo: Recording = {
  id: "rec-1",
  name: "Recording One",
  events: [
    mkEvent("e0", 1000),
    mkEvent("e1", 2000),
    mkEvent("e2", 3000),
    mkEvent("e3", 4000),
    mkEvent("e4", 5000),
  ],
  created_at: 500,
  playback_speed: 1,
  video: {
    path: "/tmp/rec-1.mp4",
    start_ms: 1000,
    duration_ms: 5000,
    width: 1920,
    height: 1080,
    fps: 30,
    has_audio: false,
  },
};

// jsdom never lays out the page, so every element's getBoundingClientRect is
// zeroed — including the ResizableHandle's. react-resizable-panels turns any
// pointerdown near a registered handle into a drag (preventDefault +
// stopImmediatePropagation on the body, in capture phase), and userEvent's
// synthetic clicks default to (0,0) too, so *every* click in this suite would
// otherwise be swallowed as "on the handle", silently blocking the focus a
// subsequent `type()` needs. Pin the real handle element(s) far offscreen so
// the coordinate collision can't happen — panels/handles still render and
// drag for real, this only fixes jsdom's missing layout.
const realGetBoundingClientRect = Element.prototype.getBoundingClientRect;
Element.prototype.getBoundingClientRect = function (this: Element) {
  if (this.hasAttribute("data-resize-handle")) {
    return {
      x: 99999,
      y: 99999,
      width: 1,
      height: 1,
      top: 99999,
      left: 99999,
      right: 100000,
      bottom: 100000,
      toJSON() {},
    } as DOMRect;
  }
  return realGetBoundingClientRect.call(this);
};

// MacroEditor no longer calls useMacros itself (it's lifted into StudioEditor
// so a run survives toggling away from the macros view) — it now consumes the
// hook's return as props. This wrapper reproduces that wiring for these tests.
function Wrapper({ recordings: recs }: { recordings: Recording[] }) {
  const macrosState = useMacros();
  return <MacroEditor recordings={recs} {...macrosState} />;
}

async function addTextWait(text = "Loaded") {
  await userEvent.type(screen.getByLabelText(/expect/i), text);
  await userEvent.click(screen.getByRole("button", { name: /add text wait/i }));
}

async function saveAndWaitForRunEnabled() {
  await userEvent.click(screen.getByRole("button", { name: /save/i }));
  await waitFor(() => expect(screen.getByRole("button", { name: /run/i })).toBeEnabled());
}

describe("MacroEditor", () => {
  beforeEach(() => {
    fake.macros = [];
    fake.rejectStop = null;
    fake.rejectRun = null;
    state.listeners.clear();
    vi.clearAllMocks();
  });

  async function selectRecording(name: string | RegExp) {
    await userEvent.click(screen.getByRole("combobox", { name: /recording/i }));
    await userEvent.click(await screen.findByRole("option", { name }));
  }

  it("shows the authoring dock only after a recording with video is selected", async () => {
    render(<Wrapper recordings={[recordingWithVideo]} />);
    await screen.findByText(/0 node/i);
    expect(screen.queryByTestId("authoring-dock")).not.toBeInTheDocument();

    await selectRecording("Recording One");
    expect(screen.getByTestId("authoring-dock")).toBeInTheDocument();
  });

  it("a dock range drives the sidebar summary and produces a matching Segment node", async () => {
    render(<Wrapper recordings={[recordingWithVideo]} />);
    await screen.findByText(/0 node/i);
    await selectRecording("Recording One");

    await userEvent.click(screen.getByRole("button", { name: /simulate dock range/i }));
    // rel [2000,4000] over basis 1000 → e2, e3, e4.
    expect(screen.getByText(/0:02–0:04 · 3 events/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /^add segment$/i }));
    expect(await screen.findByText(/1 node/i)).toBeInTheDocument();
    expect(screen.getByText("segment events: 3")).toBeInTheDocument();
  });

  it("a dock image save captures via save_target and adds a WaitFor node", async () => {
    render(<Wrapper recordings={[recordingWithVideo]} />);
    await screen.findByText(/0 node/i);
    await selectRecording("Recording One");

    await userEvent.click(screen.getByRole("button", { name: /simulate dock image save/i }));
    expect(await screen.findByText(/1 node/i)).toBeInTheDocument();
  });

  it("the dock's Add Segment builds the same node as the sidebar path", async () => {
    render(<Wrapper recordings={[recordingWithVideo]} />);
    await screen.findByText(/0 node/i);
    await selectRecording("Recording One");

    await userEvent.click(screen.getByRole("button", { name: /simulate dock range/i }));
    await userEvent.click(screen.getByRole("button", { name: /simulate dock add segment/i }));

    expect(await screen.findByText(/1 node/i)).toBeInTheDocument();
    // rel [2000,4000] over basis 1000 → e2, e3, e4 (same invariant as the
    // sidebar-path test; the canvas stub renders the built node's count).
    expect(screen.getByText("segment events: 3")).toBeInTheDocument();
  });

  it("starts with an empty draft macro: Run disabled (no nodes yet)", async () => {
    render(<Wrapper recordings={recordings} />);
    expect(await screen.findByText(/0 node/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /run/i })).toBeDisabled();
  });

  it("adding a node marks the toolbar dirty, but Run stays disabled until saved", async () => {
    render(<Wrapper recordings={recordings} />);
    await screen.findByText(/0 node/i);

    await addTextWait();

    expect(await screen.findByText(/1 node/i)).toBeInTheDocument();
    expect(screen.getByRole("status", { name: /unsaved/i })).toBeInTheDocument();
    // Single node is trivially a valid chain, but the doc is unsaved (dirty,
    // and not yet present in the stored macro list) — run_macro would 404.
    const runButton = screen.getByRole("button", { name: /run/i });
    expect(runButton).toBeDisabled();
    expect(runButton).toHaveAttribute("title", "Save before running.");
  });

  it("does not persist anything until Save is clicked (explicit save, no autosave)", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    render(<Wrapper recordings={recordings} />);
    await screen.findByText(/0 node/i);

    await addTextWait();
    await screen.findByText(/1 node/i);

    expect(invoke).not.toHaveBeenCalledWith("save_macro", expect.anything());

    await userEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        "save_macro",
        expect.objectContaining({ doc: expect.anything() }),
      );
    });
    await waitFor(() => {
      expect(screen.queryByRole("status", { name: /unsaved/i })).not.toBeInTheDocument();
    });
    // Now that it's saved and not dirty, Run is enabled.
    expect(screen.getByRole("button", { name: /run/i })).toBeEnabled();
  });

  it("dragging a node on the canvas (onChange) marks dirty without autosaving", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    render(<Wrapper recordings={recordings} />);
    await screen.findByText(/0 node/i);

    await userEvent.click(screen.getByRole("button", { name: /simulate drag/i }));

    expect(screen.getByRole("status", { name: /unsaved/i })).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalledWith("save_macro", expect.anything());
  });

  it("Run calls run_macro with the working doc's id once saved and the chain is valid", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    render(<Wrapper recordings={recordings} />);
    await screen.findByText(/0 node/i);
    await addTextWait();
    await screen.findByText(/1 node/i);

    await saveAndWaitForRunEnabled();
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("save_macro", expect.anything()));

    await userEvent.click(screen.getByRole("button", { name: /run/i }));

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        "run_macro",
        expect.objectContaining({ id: expect.any(String) }),
      );
    });
    // Run disabled + Stop shown once the (unresolved-events) run is "running".
    expect(await screen.findByRole("button", { name: /stop/i })).toBeInTheDocument();
  });

  it("Stop calls stop_macro", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    render(<Wrapper recordings={recordings} />);
    await screen.findByText(/0 node/i);
    await addTextWait();
    await saveAndWaitForRunEnabled();
    await userEvent.click(screen.getByRole("button", { name: /run/i }));

    const stopButton = await screen.findByRole("button", { name: /stop/i });
    await userEvent.click(stopButton);

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("stop_macro", expect.anything());
    });
  });

  it("does not render a removed toolbar banner when Stop fails", async () => {
    fake.rejectStop = "engine busy";
    render(<Wrapper recordings={recordings} />);
    await screen.findByText(/0 node/i);
    await addTextWait();
    await saveAndWaitForRunEnabled();
    await userEvent.click(screen.getByRole("button", { name: /run/i }));

    const stopButton = await screen.findByRole("button", { name: /stop/i });
    await userEvent.click(stopButton);

    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });

  it("does not render a removed toolbar banner when Run fails", async () => {
    fake.rejectRun = "Already playing";
    render(<Wrapper recordings={recordings} />);
    await screen.findByText(/0 node/i);
    await addTextWait();
    await saveAndWaitForRunEnabled();

    await userEvent.click(screen.getByRole("button", { name: /run/i }));

    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });

  it("does not show a status message or failed node when a run is stopped deliberately", async () => {
    render(<Wrapper recordings={recordings} />);
    await screen.findByText(/0 node/i);
    await waitFor(() => expect(state.listeners.get("macro-run-failed")).toBeDefined());

    await act(async () => {
      await state.listeners.get("macro-run-failed")?.({
        payload: { macroId: "m1", nodeId: "n1", reason: "stopped" },
      });
    });

    expect(screen.queryByText(/run stopped\./i)).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText(/failed node: none/i)).toBeInTheDocument();
  });

  it("highlights a genuine failed node without rendering the removed error banner", async () => {
    render(<Wrapper recordings={recordings} />);
    await screen.findByText(/0 node/i);
    await waitFor(() => expect(state.listeners.get("macro-run-failed")).toBeDefined());

    await act(async () => {
      await state.listeners.get("macro-run-failed")?.({
        payload: { macroId: "m1", nodeId: "n1", reason: "timeout waiting for text" },
      });
    });

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText(/failed node: n1/i)).toBeInTheDocument();
  });

  it("clears a stale failure highlight when switching to a different macro", async () => {
    fake.macros = [{ id: "m1", name: "Other Macro", nodes: [], edges: [], created_at: 1 }];
    render(<Wrapper recordings={recordings} />);
    await screen.findByText(/0 node/i);
    await waitFor(() => expect(state.listeners.get("macro-run-failed")).toBeDefined());

    await act(async () => {
      await state.listeners.get("macro-run-failed")?.({
        payload: { macroId: "x", nodeId: "n1", reason: "boom" },
      });
    });
    expect(screen.getByText(/failed node: n1/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /^macros$/i }));
    await userEvent.click(screen.getByRole("button", { name: /other macro/i }));

    expect(screen.getByText(/failed node: none/i)).toBeInTheDocument();
  });

  it("clears a stale failure highlight when creating a new macro", async () => {
    render(<Wrapper recordings={recordings} />);
    await screen.findByText(/0 node/i);
    await waitFor(() => expect(state.listeners.get("macro-run-failed")).toBeDefined());

    await act(async () => {
      await state.listeners.get("macro-run-failed")?.({
        payload: { macroId: "x", nodeId: "n1", reason: "boom" },
      });
    });
    expect(screen.getByText(/failed node: n1/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /^macros$/i }));
    await userEvent.click(screen.getByRole("button", { name: /new macro/i }));
    await userEvent.type(screen.getByLabelText(/macro name/i), "Fresh");
    await userEvent.click(screen.getByRole("button", { name: /^create$/i }));

    expect(screen.getByText(/failed node: none/i)).toBeInTheDocument();
  });

  it("creating a named macro via the menu seeds a fresh working doc", async () => {
    render(<Wrapper recordings={recordings} />);
    await screen.findByText(/0 node/i);

    await userEvent.click(screen.getByRole("button", { name: /^macros$/i }));
    await userEvent.click(screen.getByRole("button", { name: /new macro/i }));
    await userEvent.type(screen.getByLabelText(/macro name/i), "My Flow");
    await userEvent.click(screen.getByRole("button", { name: /^create$/i }));

    expect(await screen.findByText("My Flow")).toBeInTheDocument();
  });

  it("selecting a saved macro from the menu loads it as the working doc", async () => {
    const node: MacroNode = {
      id: "n1",
      kind: {
        type: "WaitFor",
        target: {
          id: "t1",
          name: "Submit",
          modality: "visual",
          region: { x: 0, y: 0, w: 1, h: 1 },
          kind: { type: "TextOcr", expect: "Submit" },
          created_at: 1,
        },
        timeout_ms: 5000,
        poll_interval_ms: 500,
      },
      x: 0,
      y: 0,
    };
    fake.macros = [{ id: "m1", name: "Saved Macro", nodes: [node], edges: [], created_at: 1 }];

    render(<Wrapper recordings={recordings} />);
    await screen.findByText(/saved macro/i);

    await userEvent.click(screen.getByRole("button", { name: /^macros$/i }));
    await userEvent.click(screen.getByRole("button", { name: /saved macro/i }));

    expect(await screen.findByText(/1 node/i)).toBeInTheDocument();
    expect(screen.queryByRole("status", { name: /unsaved/i })).not.toBeInTheDocument();
    // Loaded straight from the stored list: not dirty, already "saved" — Run
    // is immediately available (no forced re-save just to run it).
    expect(screen.getByRole("button", { name: /run/i })).toBeEnabled();
  });

  it("deletes a macro via two-click confirm and resets to a fresh draft when it was selected", async () => {
    fake.macros = [{ id: "m1", name: "Doomed", nodes: [], edges: [], created_at: 1 }];

    render(<Wrapper recordings={recordings} />);
    await screen.findByText(/doomed/i);

    await userEvent.click(screen.getByRole("button", { name: /^macros$/i }));
    await userEvent.click(screen.getByRole("button", { name: /doomed/i }));
    await screen.findByText(/^doomed$/i);

    await userEvent.click(screen.getByRole("button", { name: /^macros$/i }));
    const deleteButton = screen.getByRole("button", { name: /delete macro/i });
    await userEvent.click(deleteButton);
    await userEvent.click(deleteButton);

    await waitFor(() => {
      expect(screen.queryByText(/^doomed$/i)).not.toBeInTheDocument();
    });
  });
});
