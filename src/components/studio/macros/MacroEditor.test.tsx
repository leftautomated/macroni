import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { MacroDoc, MacroNode, Recording } from "@/types";

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
      <button
        type="button"
        onClick={() => onChange({ ...doc, nodes: doc.nodes.map((n) => ({ ...n, x: n.x + 1 })) })}
      >
        Simulate drag
      </button>
    </div>
  ),
}));

import { MacroEditor } from "@/components/studio/macros/MacroEditor";
import { useMacros } from "@/hooks/useMacros";

const recordings: Recording[] = [];

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

  it("surfaces a stop failure in the toolbar banner", async () => {
    fake.rejectStop = "engine busy";
    render(<Wrapper recordings={recordings} />);
    await screen.findByText(/0 node/i);
    await addTextWait();
    await saveAndWaitForRunEnabled();
    await userEvent.click(screen.getByRole("button", { name: /run/i }));

    const stopButton = await screen.findByRole("button", { name: /stop/i });
    await userEvent.click(stopButton);

    expect(await screen.findByRole("alert")).toHaveTextContent(/engine busy/i);
  });

  it('surfaces a plain-string "Already playing" run rejection as "Stop playback first."', async () => {
    fake.rejectRun = "Already playing";
    render(<Wrapper recordings={recordings} />);
    await screen.findByText(/0 node/i);
    await addTextWait();
    await saveAndWaitForRunEnabled();

    await userEvent.click(screen.getByRole("button", { name: /run/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/stop playback first/i);
  });

  it("surfaces other plain-string run rejections verbatim (e.g. an invalid chain caught server-side)", async () => {
    fake.rejectRun = "Macro nodes must form a single linear chain";
    render(<Wrapper recordings={recordings} />);
    await screen.findByText(/0 node/i);
    await addTextWait();
    await saveAndWaitForRunEnabled();

    await userEvent.click(screen.getByRole("button", { name: /run/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /macro nodes must form a single linear chain/i,
    );
  });

  it("shows a neutral message (not the red banner or a red node) when a run is stopped deliberately", async () => {
    render(<Wrapper recordings={recordings} />);
    await screen.findByText(/0 node/i);
    await waitFor(() => expect(state.listeners.get("macro-run-failed")).toBeDefined());

    await act(async () => {
      await state.listeners.get("macro-run-failed")?.({
        payload: { macroId: "m1", nodeId: "n1", reason: "stopped" },
      });
    });

    expect(await screen.findByText(/run stopped\./i)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText(/failed node: none/i)).toBeInTheDocument();
  });

  it("shows the red failure banner and highlights the failed node for a genuine (non-stopped) failure", async () => {
    render(<Wrapper recordings={recordings} />);
    await screen.findByText(/0 node/i);
    await waitFor(() => expect(state.listeners.get("macro-run-failed")).toBeDefined());

    await act(async () => {
      await state.listeners.get("macro-run-failed")?.({
        payload: { macroId: "m1", nodeId: "n1", reason: "timeout waiting for text" },
      });
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(/timeout waiting for text/i);
    expect(screen.getByText(/failed node: n1/i)).toBeInTheDocument();
  });

  it("clears a stale failure banner/highlight when switching to a different macro", async () => {
    fake.macros = [{ id: "m1", name: "Other Macro", nodes: [], edges: [], created_at: 1 }];
    render(<Wrapper recordings={recordings} />);
    await screen.findByText(/0 node/i);
    await waitFor(() => expect(state.listeners.get("macro-run-failed")).toBeDefined());

    await act(async () => {
      await state.listeners.get("macro-run-failed")?.({
        payload: { macroId: "x", nodeId: "n1", reason: "boom" },
      });
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(/boom/i);

    await userEvent.click(screen.getByRole("button", { name: /^macros$/i }));
    await userEvent.click(screen.getByRole("button", { name: /other macro/i }));

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText(/failed node: none/i)).toBeInTheDocument();
  });

  it("clears a stale failure banner when creating a new macro", async () => {
    render(<Wrapper recordings={recordings} />);
    await screen.findByText(/0 node/i);
    await waitFor(() => expect(state.listeners.get("macro-run-failed")).toBeDefined());

    await act(async () => {
      await state.listeners.get("macro-run-failed")?.({
        payload: { macroId: "x", nodeId: "n1", reason: "boom" },
      });
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(/boom/i);

    await userEvent.click(screen.getByRole("button", { name: /^macros$/i }));
    await userEvent.click(screen.getByRole("button", { name: /new macro/i }));
    await userEvent.type(screen.getByLabelText(/macro name/i), "Fresh");
    await userEvent.click(screen.getByRole("button", { name: /^create$/i }));

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
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
