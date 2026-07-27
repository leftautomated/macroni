import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, act, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { MacroRunFailure, MacroRunState } from "@/hooks/useMacros";
import {
  InputEventType,
  type InputEvent,
  type MacroDoc,
  type MacroRule,
  type PerceptionTarget,
  type Recording,
  type TextSpan,
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
  rejectOcr: false,
  rejectSaveTarget: false,
  spans: [] as TextSpan[],
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
      case "extract_region": {
        if (fake.rejectOcr) throw new Error("ocr backend exploded");
        const kind = args?.kind as { type: string };
        if (kind.type === "ColorSample") return { type: "Color", rgb: [1, 2, 3], matched: true };
        return { type: "Text", spans: fake.spans };
      }
      case "save_target": {
        if (fake.rejectSaveTarget) throw new Error("crop failed");
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

// The real AuthoringDock renders for real (its selector, Add rule button and
// picker slot are what the authoring flow is driven through); only the video
// element underneath is stubbed, exposing onTimeUpdate so tests can move the
// playhead and onSaveTarget so a frame drag can be simulated.
vi.mock("@/components/studio/StudioPlayer", async () => {
  const { forwardRef, useImperativeHandle } = await import("react");
  return {
    StudioPlayer: forwardRef(
      (
        {
          onTimeUpdate,
          onSaveTarget,
        }: {
          onTimeUpdate: (seconds: number) => void;
          onSaveTarget?: (target: PerceptionTarget, timestampMs: number) => Promise<void>;
        },
        ref: React.Ref<{ seek: (s: number) => void; pause: () => void }>,
      ) => {
        useImperativeHandle(ref, () => ({ seek: () => {}, pause: () => {} }));
        return (
          <div data-testid="player-stub">
            <button type="button" onClick={() => onTimeUpdate(2)}>
              Simulate scrub to 2s
            </button>
            <button
              type="button"
              onClick={() =>
                onSaveTarget?.(
                  {
                    id: "t-img",
                    name: "Health bar",
                    modality: "visual",
                    region: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
                    kind: { type: "TemplateMatch", image: "", threshold: 0.8, source_px: [0, 0] },
                    created_at: 1,
                  },
                  1500,
                )
              }
            >
              Simulate frame drag
            </button>
          </div>
        );
      },
    ),
  };
});

vi.mock("@/hooks/useVideoAssetUrl", () => ({
  useVideoAssetUrl: () => ({ url: "asset://video.mp4", error: null }),
}));

import { MacroEditor, type MacroEditorProps } from "@/components/studio/macros/MacroEditor";
import { useMacros } from "@/hooks/useMacros";

function mkEvent(key: string, timestamp: number): InputEvent {
  return { type: InputEventType.KeyPress, key, timestamp };
}

const recordingOne: Recording = {
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

const recordingTwo: Recording = {
  ...recordingOne,
  id: "rec-2",
  name: "Recording Two",
  events: [],
};

const span = (text: string): TextSpan => ({
  text,
  region: { x: 0.4, y: 0.2, w: 0.2, h: 0.05 },
  confidence: 0.94,
});

function textTrigger(name: string): PerceptionTarget {
  return {
    id: `t-${name}`,
    name,
    modality: "visual",
    region: { x: 0.4, y: 0.2, w: 0.2, h: 0.05 },
    kind: { type: "TextOcr", expect: name },
    created_at: 1,
  };
}

function mkRule(id: string, over: Partial<MacroRule> = {}): MacroRule {
  return {
    id,
    trigger: textTrigger(id === "r1" ? "climb the stairs" : "open the door"),
    action: {
      type: "PlayInputs",
      events: [mkEvent("a", 0), mkEvent("b", 1000)],
      speed: 1,
      provenance: { recording_id: "rec-1", start_ms: 0, end_ms: 1000 },
    },
    enabled: true,
    anchor: { recording_id: "rec-1", timestamp_ms: 0 },
    ...over,
  };
}

function mkDoc(id: string, rules: MacroRule[], name = "Saved Macro"): MacroDoc {
  return { id, name, rules, poll_interval_ms: 250, created_at: 1 };
}

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
function Wrapper({ recordings }: { recordings: Recording[] }) {
  const macrosState = useMacros();
  return <MacroEditor recordings={recordings} {...macrosState} />;
}

/** Static useMacros-shaped props, for the presentational assertions. */
function macroProps(
  over: Partial<{
    macros: MacroDoc[];
    runState: MacroRunState;
    liveRuleId: string | null;
    failed: MacroRunFailure | null;
    clearFailed: () => void;
  }> = {},
): Omit<MacroEditorProps, "recordings"> {
  return {
    macros: [],
    load: async () => {},
    save: async (doc: MacroDoc) => doc,
    remove: async () => {},
    run: async () => {},
    stop: async () => {},
    runState: "idle",
    liveRuleId: null,
    failed: null,
    clearFailed: () => {},
    ...over,
  };
}

const cardLabels = () =>
  Array.from(document.querySelectorAll(".rc-when-label")).map((el) => el.textContent);

describe("MacroEditor", () => {
  beforeEach(() => {
    fake.macros = [];
    fake.rejectStop = null;
    fake.rejectRun = null;
    fake.rejectOcr = false;
    fake.rejectSaveTarget = false;
    fake.spans = [span("climb the stairs"), span("quit")];
    state.listeners.clear();
    vi.clearAllMocks();
  });

  it("renders one deck card per rule of the selected macro", async () => {
    render(
      <MacroEditor
        recordings={[recordingOne]}
        {...macroProps({ macros: [mkDoc("m1", [mkRule("r1"), mkRule("r2")])] })}
      />,
    );

    await waitFor(() => expect(cardLabels()).toHaveLength(2));
    expect(cardLabels()).toEqual(['When "climb the stairs"', 'When "open the door"']);
  });

  it("shows no empty-state copy for a macro with no rules — just the Add affordance", async () => {
    const { container } = render(
      <MacroEditor recordings={[recordingOne]} {...macroProps({ macros: [mkDoc("m1", [])] })} />,
    );

    await screen.findByRole("button", { name: "Add rule" });
    expect(container.querySelectorAll(".rc-root")).toHaveLength(0);
    const copy = container.textContent?.toLowerCase() ?? "";
    expect(copy).not.toContain("no rules");
    expect(copy).not.toContain("no nodes");
    expect(copy).not.toContain("nothing here");
  });

  it("renders a plain stage with no copy when no recording has video", () => {
    const { container } = render(
      <MacroEditor
        recordings={[{ ...recordingOne, video: undefined }]}
        {...macroProps({ macros: [mkDoc("m1", [])] })}
      />,
    );
    const stage = container.querySelector(".macro-editor-canvas-pane");
    expect(stage).not.toBeNull();
    expect(stage?.textContent).toBe("");
  });

  describe("add-rule flow", () => {
    it("OCRs the frame, picks a span, and adds the rule from the draft card", async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      render(<Wrapper recordings={[recordingOne]} />);
      await screen.findByRole("button", { name: "Add rule" });

      await userEvent.click(screen.getByRole("button", { name: "Add rule" }));

      await waitFor(() =>
        expect(invoke).toHaveBeenCalledWith(
          "extract_region",
          // `traceId` rides along on every observability invoke.
          expect.objectContaining({
            source: { type: "Recording", recording_id: "rec-1", timestamp_ms: 0 },
            region: { x: 0, y: 0, w: 1, h: 1 },
            kind: { type: "TextOcr", expect: null },
          }),
        ),
      );

      // Picker offers one box per detected span.
      const spanButton = await screen.findByRole("button", {
        name: 'Use text "climb the stairs" as the trigger',
      });
      await userEvent.click(spanButton);

      // Draft card: the trigger, plus the pre-selected action range (anchor 0
      // → end of the recording; all 5 events fall inside it).
      const draft = document.querySelector(".rd-draft") as HTMLElement;
      expect(within(draft).getByText(/climb the stairs/)).toBeInTheDocument();
      expect(within(draft).getByText(/0:00–0:05 · 5 events/)).toBeInTheDocument();

      await userEvent.click(screen.getByRole("button", { name: 'Add rule: "climb the stairs"' }));

      await waitFor(() => expect(cardLabels()).toEqual(['When "climb the stairs"']));
      expect(document.querySelector(".rd-draft")).toBeNull();
      expect(screen.getByRole("button", { name: "Save unsaved changes" })).toBeInTheDocument();
    });

    it("anchors at the dock playhead when the deck's Add rule is used after a scrub", async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      render(<Wrapper recordings={[recordingOne]} />);
      await screen.findByRole("button", { name: "Add rule" });

      await userEvent.click(screen.getByRole("button", { name: /simulate scrub to 2s/i }));
      await userEvent.click(screen.getByRole("button", { name: "Add rule" }));

      await waitFor(() =>
        expect(invoke).toHaveBeenCalledWith(
          "extract_region",
          expect.objectContaining({
            source: { type: "Recording", recording_id: "rec-1", timestamp_ms: 2000 },
          }),
        ),
      );
    });

    it("degrades to the drag-a-box hint when the frame OCR fails", async () => {
      const { error } = await import("@tauri-apps/plugin-log");
      fake.rejectOcr = true;
      render(<Wrapper recordings={[recordingOne]} />);
      await screen.findByRole("button", { name: "Add rule" });

      await userEvent.click(screen.getByRole("button", { name: "Add rule" }));

      expect(await screen.findByText(/no text found/i)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /as the trigger/ })).not.toBeInTheDocument();
      await waitFor(() => expect(error).toHaveBeenCalled());
    });

    it("builds a Stop rule when the draft's action is toggled, with no range needed", async () => {
      render(<Wrapper recordings={[recordingOne]} />);
      await screen.findByRole("button", { name: "Add rule" });

      await userEvent.click(screen.getByRole("button", { name: "Add rule" }));
      await userEvent.click(
        await screen.findByRole("button", { name: 'Use text "quit" as the trigger' }),
      );
      await userEvent.click(screen.getByRole("button", { name: "Stop macro" }));
      // The range chip is gone — a Stop action doesn't replay anything.
      expect(document.querySelector(".rd-draft-chip")).toBeNull();

      await userEvent.click(screen.getByRole("button", { name: 'Add rule: "quit"' }));

      await waitFor(() => expect(cardLabels()).toEqual(['When "quit"']));
      expect(screen.getByText("Stop macro", { selector: ".rc-then" })).toBeInTheDocument();
    });

    it("shows an inline error on the draft card when the frame capture fails", async () => {
      fake.rejectSaveTarget = true;
      render(<Wrapper recordings={[recordingOne]} />);
      await screen.findByRole("button", { name: "Add rule" });

      await userEvent.click(screen.getByRole("button", { name: /simulate frame drag/i }));

      expect(await screen.findByText("Couldn't capture that — try again")).toBeInTheDocument();
      expect(cardLabels()).toHaveLength(0);
    });

    it("Cancel drops the draft without touching the doc", async () => {
      render(<Wrapper recordings={[recordingOne]} />);
      await screen.findByRole("button", { name: "Add rule" });

      await userEvent.click(screen.getByRole("button", { name: "Add rule" }));
      await screen.findByRole("button", { name: 'Use text "quit" as the trigger' });
      await userEvent.click(screen.getAllByRole("button", { name: "Cancel rule draft" })[0]);

      expect(document.querySelector(".rd-draft")).toBeNull();
      expect(cardLabels()).toHaveLength(0);
      expect(
        screen.queryByRole("button", { name: "Save unsaved changes" }),
      ).not.toBeInTheDocument();
    });
  });

  describe("deck editing", () => {
    it("reorders, toggles and deletes rules, marking the doc dirty", async () => {
      fake.macros = [mkDoc("m1", [mkRule("r1"), mkRule("r2")])];
      render(<Wrapper recordings={[recordingOne]} />);
      await waitFor(() => expect(cardLabels()).toHaveLength(2));

      await userEvent.click(screen.getByRole("button", { name: 'Move down: "climb the stairs"' }));
      expect(cardLabels()).toEqual(['When "open the door"', 'When "climb the stairs"']);
      expect(screen.getByRole("button", { name: "Save unsaved changes" })).toBeInTheDocument();

      const toggle = screen.getByRole("switch", { name: 'Rule enabled: "open the door"' });
      expect(toggle).toBeChecked();
      await userEvent.click(toggle);
      expect(
        screen.getByRole("switch", { name: 'Rule enabled: "open the door"' }),
      ).not.toBeChecked();

      await userEvent.click(screen.getByRole("button", { name: 'Delete rule: "open the door"' }));
      expect(cardLabels()).toEqual(['When "climb the stairs"']);
    });

    it("clicking a card anchored on another recording switches the dock's recording", async () => {
      fake.macros = [
        mkDoc("m1", [
          mkRule("r2", {
            anchor: { recording_id: "rec-2", timestamp_ms: 1200 },
          }),
        ]),
      ];
      render(<Wrapper recordings={[recordingOne, recordingTwo]} />);
      await waitFor(() => expect(cardLabels()).toHaveLength(1));
      expect(screen.getByRole("combobox", { name: "Recording" })).toHaveTextContent(
        "Recording One",
      );

      await userEvent.click(screen.getByText('When "open the door"'));

      await waitFor(() =>
        expect(screen.getByRole("combobox", { name: "Recording" })).toHaveTextContent(
          "Recording Two",
        ),
      );
    });
  });

  describe("run gating", () => {
    it("disables Run with a reason while the working doc is unsaved", async () => {
      fake.macros = [mkDoc("m1", [mkRule("r1")])];
      render(<Wrapper recordings={[recordingOne]} />);
      await waitFor(() => expect(cardLabels()).toHaveLength(1));

      // Loaded straight from the store: saved, not dirty → Run is available.
      expect(screen.getByRole("button", { name: /run/i })).toBeEnabled();

      await userEvent.click(
        screen.getByRole("switch", { name: 'Rule enabled: "climb the stairs"' }),
      );

      const runButton = screen.getByRole("button", { name: /run/i });
      expect(runButton).toBeDisabled();
      expect(runButton).toHaveAttribute("title", "Save before running.");
    });

    it("disables Run for a doc with no runnable rules", async () => {
      fake.macros = [mkDoc("m1", [])];
      render(<Wrapper recordings={[recordingOne]} />);
      await screen.findByRole("button", { name: "Add rule" });
      expect(screen.getByRole("button", { name: /run/i })).toBeDisabled();
    });

    it("Run calls run_macro and Stop calls stop_macro", async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      fake.macros = [mkDoc("m1", [mkRule("r1")])];
      render(<Wrapper recordings={[recordingOne]} />);
      await waitFor(() => expect(cardLabels()).toHaveLength(1));

      await userEvent.click(screen.getByRole("button", { name: /run/i }));
      await waitFor(() =>
        expect(invoke).toHaveBeenCalledWith("run_macro", expect.objectContaining({ id: "m1" })),
      );

      await userEvent.click(await screen.findByRole("button", { name: /stop/i }));
      await waitFor(() => expect(invoke).toHaveBeenCalledWith("stop_macro", expect.anything()));
    });

    it("does not persist anything until Save is clicked (explicit save, no autosave)", async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      fake.macros = [mkDoc("m1", [mkRule("r1"), mkRule("r2")])];
      render(<Wrapper recordings={[recordingOne]} />);
      await waitFor(() => expect(cardLabels()).toHaveLength(2));

      await userEvent.click(screen.getByRole("button", { name: 'Delete rule: "open the door"' }));
      expect(invoke).not.toHaveBeenCalledWith("save_macro", expect.anything());

      await userEvent.click(screen.getByRole("button", { name: /save/i }));
      await waitFor(() =>
        expect(invoke).toHaveBeenCalledWith(
          "save_macro",
          expect.objectContaining({ doc: expect.objectContaining({ id: "m1" }) }),
        ),
      );
      await waitFor(() => expect(screen.getByRole("button", { name: /run/i })).toBeEnabled());
    });
  });

  describe("run feedback", () => {
    it("flags the live rule's card", async () => {
      render(
        <MacroEditor
          recordings={[recordingOne]}
          {...macroProps({
            macros: [mkDoc("m1", [mkRule("r1"), mkRule("r2")])],
            runState: "running",
            liveRuleId: "r2",
          })}
        />,
      );

      await waitFor(() => expect(document.querySelectorAll(".rc-root")).toHaveLength(2));
      const cards = document.querySelectorAll(".rc-root");
      expect(cards[0].getAttribute("data-live")).toBeNull();
      expect(cards[1].getAttribute("data-live")).toBe("true");
    });

    it("flags a genuinely failed rule red, but never a deliberate stop", async () => {
      const doc = mkDoc("m1", [mkRule("r1")]);
      const { rerender } = render(
        <MacroEditor
          recordings={[recordingOne]}
          {...macroProps({ macros: [doc], failed: { ruleId: "r1", reason: "stopped" } })}
        />,
      );

      await waitFor(() => expect(document.querySelectorAll(".rc-root")).toHaveLength(1));
      expect(document.querySelector(".rc-root")?.getAttribute("data-failed")).toBeNull();
      expect(screen.queryByText("stopped")).not.toBeInTheDocument();

      rerender(
        <MacroEditor
          recordings={[recordingOne]}
          {...macroProps({
            macros: [doc],
            failed: { ruleId: "r1", reason: "evaluation-error: boom" },
          })}
        />,
      );
      expect(document.querySelector(".rc-root")?.getAttribute("data-failed")).toBe("true");
      expect(screen.getByText("evaluation-error: boom")).toBeInTheDocument();
    });

    it("clears a stale failure when a different macro is selected", async () => {
      const clearFailed = vi.fn();
      render(
        <MacroEditor
          recordings={[recordingOne]}
          {...macroProps({
            macros: [mkDoc("m1", [mkRule("r1")]), mkDoc("m2", [mkRule("r2")], "Other Macro")],
            failed: { ruleId: "r1", reason: "boom" },
            clearFailed,
          })}
        />,
      );
      await waitFor(() => expect(document.querySelectorAll(".rc-root")).toHaveLength(1));

      await userEvent.click(screen.getByRole("button", { name: /^macros$/i }));
      await userEvent.click(screen.getByRole("button", { name: /other macro/i }));

      expect(clearFailed).toHaveBeenCalled();
      await waitFor(() => expect(cardLabels()).toEqual(['When "open the door"']));
    });
  });

  describe("macro management", () => {
    it("creating a named macro via the menu seeds a fresh empty working doc", async () => {
      render(<Wrapper recordings={[recordingOne]} />);
      await screen.findByRole("button", { name: "Add rule" });

      await userEvent.click(screen.getByRole("button", { name: /^macros$/i }));
      await userEvent.click(screen.getByRole("button", { name: /new macro/i }));
      await userEvent.type(screen.getByLabelText(/macro name/i), "My Flow");
      await userEvent.click(screen.getByRole("button", { name: /^create$/i }));

      expect(await screen.findByText("My Flow")).toBeInTheDocument();
      expect(cardLabels()).toHaveLength(0);
    });

    it("deletes a macro via two-click confirm and resets to a fresh draft", async () => {
      fake.macros = [mkDoc("m1", [], "Doomed")];
      render(<Wrapper recordings={[recordingOne]} />);
      await screen.findByText(/doomed/i);

      await userEvent.click(screen.getByRole("button", { name: /^macros$/i }));
      await userEvent.click(screen.getByRole("button", { name: /doomed/i }));
      await screen.findByText(/^doomed$/i);

      await userEvent.click(screen.getByRole("button", { name: /^macros$/i }));
      const deleteButton = screen.getByRole("button", { name: /delete macro/i });
      await userEvent.click(deleteButton);
      await userEvent.click(deleteButton);

      await waitFor(() => expect(screen.queryByText(/^doomed$/i)).not.toBeInTheDocument());
    });

    it("does not render a removed toolbar banner when Run or Stop fails", async () => {
      fake.rejectRun = "Already playing";
      fake.macros = [mkDoc("m1", [mkRule("r1")])];
      render(<Wrapper recordings={[recordingOne]} />);
      await waitFor(() => expect(cardLabels()).toHaveLength(1));

      await userEvent.click(screen.getByRole("button", { name: /run/i }));
      await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    });

    it("subscribes to the renamed rule events through useMacros", async () => {
      render(<Wrapper recordings={[recordingOne]} />);
      await waitFor(() => expect(state.listeners.get("macro-rule-fired")).toBeDefined());
      expect(state.listeners.get("macro-rule-settled")).toBeDefined();
      expect(state.listeners.get("macro-run-finished")).toBeDefined();
      expect(state.listeners.get("macro-run-failed")).toBeDefined();
    });

    it("highlights the live card from a macro-rule-fired event", async () => {
      fake.macros = [mkDoc("m1", [mkRule("r1")])];
      render(<Wrapper recordings={[recordingOne]} />);
      await waitFor(() => expect(cardLabels()).toHaveLength(1));

      await act(async () => {
        await state.listeners.get("macro-rule-fired")?.({
          payload: { macroId: "m1", ruleId: "r1", index: 0 },
        });
      });
      expect(document.querySelector(".rc-root")?.getAttribute("data-live")).toBe("true");

      await act(async () => {
        await state.listeners.get("macro-rule-settled")?.({
          payload: { macroId: "m1", ruleId: "r1", index: 0 },
        });
      });
      expect(document.querySelector(".rc-root")?.getAttribute("data-live")).toBeNull();
    });
  });
});
