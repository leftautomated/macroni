import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { MacroDoc, MacroNode, Recording } from "@/types";

// In-memory backend the mocked Tauri commands talk to. `rejectStop` lets a
// single test force stop_macro to fail without leaking into the others.
const fake = { macros: [] as MacroDoc[], rejectStop: null as string | null };

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
  listen: vi.fn(async () => () => {}),
}));

// The real MacroCanvas renders react-flow, which isn't exercised under jsdom
// here — a stub exposes just enough surface (node count + a button that fires
// onChange) to test MacroEditor's dirty/save wiring without it.
vi.mock("@/components/studio/macros/MacroCanvas", () => ({
  MacroCanvas: ({ doc, onChange }: { doc: MacroDoc; onChange: (doc: MacroDoc) => void }) => (
    <div>
      <div>canvas: {doc.nodes.length} node(s)</div>
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

const recordings: Recording[] = [];

async function addTextWait(text = "Loaded") {
  await userEvent.type(screen.getByLabelText(/expect/i), text);
  await userEvent.click(screen.getByRole("button", { name: /add text wait/i }));
}

describe("MacroEditor", () => {
  beforeEach(() => {
    fake.macros = [];
    fake.rejectStop = null;
    vi.clearAllMocks();
  });

  it("starts with an empty draft macro: Run disabled (no nodes yet)", async () => {
    render(<MacroEditor recordings={recordings} />);
    expect(await screen.findByText(/0 node/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /run/i })).toBeDisabled();
  });

  it("adding a node marks the toolbar dirty and enables Run (single node is trivially a chain)", async () => {
    render(<MacroEditor recordings={recordings} />);
    await screen.findByText(/0 node/i);

    await addTextWait();

    expect(await screen.findByText(/1 node/i)).toBeInTheDocument();
    expect(screen.getByRole("status", { name: /unsaved/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /run/i })).toBeEnabled();
  });

  it("does not persist anything until Save is clicked (explicit save, no autosave)", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    render(<MacroEditor recordings={recordings} />);
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
  });

  it("dragging a node on the canvas (onChange) marks dirty without autosaving", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    render(<MacroEditor recordings={recordings} />);
    await screen.findByText(/0 node/i);

    await userEvent.click(screen.getByRole("button", { name: /simulate drag/i }));

    expect(screen.getByRole("status", { name: /unsaved/i })).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalledWith("save_macro", expect.anything());
  });

  it("Run calls run_macro with the working doc's id once the chain is valid", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    render(<MacroEditor recordings={recordings} />);
    await screen.findByText(/0 node/i);
    await addTextWait();
    await screen.findByText(/1 node/i);

    await userEvent.click(screen.getByRole("button", { name: /save/i }));
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
    render(<MacroEditor recordings={recordings} />);
    await screen.findByText(/0 node/i);
    await addTextWait();
    await userEvent.click(screen.getByRole("button", { name: /run/i }));

    const stopButton = await screen.findByRole("button", { name: /stop/i });
    await userEvent.click(stopButton);

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("stop_macro", expect.anything());
    });
  });

  it("surfaces a stop failure in the toolbar banner", async () => {
    fake.rejectStop = "engine busy";
    render(<MacroEditor recordings={recordings} />);
    await screen.findByText(/0 node/i);
    await addTextWait();
    await userEvent.click(screen.getByRole("button", { name: /run/i }));

    const stopButton = await screen.findByRole("button", { name: /stop/i });
    await userEvent.click(stopButton);

    expect(await screen.findByRole("alert")).toHaveTextContent(/engine busy/i);
  });

  it("creating a named macro via the menu seeds a fresh working doc", async () => {
    render(<MacroEditor recordings={recordings} />);
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

    render(<MacroEditor recordings={recordings} />);
    await screen.findByText(/saved macro/i);

    await userEvent.click(screen.getByRole("button", { name: /^macros$/i }));
    await userEvent.click(screen.getByRole("button", { name: /saved macro/i }));

    expect(await screen.findByText(/1 node/i)).toBeInTheDocument();
    expect(screen.queryByRole("status", { name: /unsaved/i })).not.toBeInTheDocument();
  });

  it("deletes a macro via two-click confirm and resets to a fresh draft when it was selected", async () => {
    fake.macros = [{ id: "m1", name: "Doomed", nodes: [], edges: [], created_at: 1 }];

    render(<MacroEditor recordings={recordings} />);
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
