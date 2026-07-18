import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { InputEventType, type Recording } from "@/types";
import { defaultProjectDoc, type ProjectDoc } from "@/types/project";

// In-memory backend the mocked Tauri commands talk to.
const fake = { recordings: [] as Recording[], projects: new Map<string, ProjectDoc>() };

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    switch (cmd) {
      case "load_recordings":
        return [...fake.recordings];
      case "get_app_data_dir":
        return "/data";
      case "studio_load_project":
        return fake.projects.get(String(args?.recordingId)) ?? defaultProjectDoc();
      case "studio_save_project":
        fake.projects.set(String(args?.recordingId), args?.doc as ProjectDoc);
        return undefined;
      case "delete_recording":
        fake.recordings = fake.recordings.filter((r) => r.id !== args?.id);
        return undefined;
      case "update_recording_name": {
        const recording = fake.recordings.find((r) => r.id === args?.id);
        if (!recording) throw new Error("recording not found");
        const updated = { ...recording, name: String(args?.name ?? recording.name) };
        fake.recordings = fake.recordings.map((r) => (r.id === updated.id ? updated : r));
        return updated;
      }
      case "load_observations":
        return [];
      case "load_macros":
        return [];
      default:
        return undefined;
    }
  }),
  convertFileSrc: vi.fn((p: string) => `asset://${p}`),
}));

// The custom title bar drives the window; stub it so renders don't hit Tauri.
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    close: vi.fn(),
    minimize: vi.fn(),
    maximize: vi.fn(),
    toggleMaximize: vi.fn(),
  }),
}));

// useMacros (pulled in via MacroEditor) listens for run events over Tauri's
// event bridge, which doesn't exist under jsdom.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

// MacroCanvas renders react-flow, which isn't exercised here — these tests
// only need to prove the macros view is reachable and the player hides, not
// exercise the canvas itself. A stub keeps the view-switch test from paying
// for (or risking) a react-flow mount under jsdom.
vi.mock("@/components/studio/macros/MacroCanvas", () => ({
  MacroCanvas: () => <div>macro canvas stub</div>,
}));

import { StudioEditor } from "@/components/studio/StudioEditor";

function makeRecording(id: string, name: string): Recording {
  return {
    id,
    name,
    events: [],
    created_at: Number(id),
    playback_speed: 1,
    video: {
      path: `${id}.mp4`,
      start_ms: 0,
      duration_ms: 5000,
      width: 1920,
      height: 1080,
      fps: 30,
      has_audio: false,
    },
  };
}

function makeInputOnlyRecording(id: string, name: string): Recording {
  return {
    id,
    name,
    events: [
      { type: InputEventType.KeyPress, key: "KeyA", timestamp: Number(id) },
      { type: InputEventType.KeyRelease, key: "KeyA", timestamp: Number(id) + 1200 },
    ],
    created_at: Number(id),
    playback_speed: 1,
  };
}

describe("StudioEditor (recordings browser)", () => {
  beforeEach(() => {
    fake.recordings = [];
    fake.projects.clear();
    vi.clearAllMocks();
  });

  it("shows the empty state when there are no recordings", async () => {
    render(<StudioEditor />);
    await waitFor(() => {
      expect(screen.getByText(/no recordings yet/i)).toBeInTheDocument();
    });
  });

  it("lists recordings in the folder menu", async () => {
    fake.recordings = [makeRecording("1000", "Older clip"), makeRecording("2000", "Newer clip")];
    render(<StudioEditor />);
    // Newest auto-selected → its name shows in the title bar.
    await waitFor(() => {
      expect(screen.getAllByText("Newer clip").length).toBeGreaterThan(0);
    });
    // Open the folder menu to reveal the full list.
    await userEvent.click(screen.getByRole("button", { name: /recordings/i }));
    expect(await screen.findByText("Older clip")).toBeInTheDocument();
  });

  it("selects a newly discovered recording and preserves it on ordinary refreshes", async () => {
    fake.recordings = [makeInputOnlyRecording("1000", "Original")];
    render(<StudioEditor />);

    await waitFor(() => {
      expect(screen.getByTitle("Click to rename")).toHaveTextContent("Original");
    });

    fake.recordings = [
      makeInputOnlyRecording("1000", "Original"),
      makeInputOnlyRecording("2000", "Newest recording"),
    ];
    act(() => window.dispatchEvent(new Event("focus")));

    await waitFor(() => {
      expect(screen.getByTitle("Click to rename")).toHaveTextContent("Newest recording");
    });

    await userEvent.click(screen.getByRole("button", { name: /recordings/i }));
    await userEvent.click(await screen.findByText("Original"));
    expect(screen.getByTitle("Click to rename")).toHaveTextContent("Original");

    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => {
      expect(screen.getByTitle("Click to rename")).toHaveTextContent("Original");
    });
  });

  it("lists and selects recordings captured without screen video", async () => {
    fake.recordings = [
      makeRecording("1000", "Video clip"),
      makeInputOnlyRecording("2000", "Input only"),
    ];
    render(<StudioEditor />);

    expect(
      await screen.findByRole("heading", { name: "Input-only recording" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/no screen video was captured/i)).toBeInTheDocument();
    expect(screen.getByRole("slider", { name: "Zoom" })).toBeInTheDocument();
    expect(document.querySelectorAll(".tl-tick")).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: /recordings/i }));
    const menuName = (await screen.findAllByText("Input only")).find((element) =>
      element.classList.contains("rm-name"),
    );
    const row = menuName?.closest(".rm-row") as HTMLElement;
    expect(within(row).getByText("No video · 2 actions")).toBeInTheDocument();
  });

  it("replays and renames an input-only recording", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    fake.recordings = [makeInputOnlyRecording("2000", "Input only")];
    render(<StudioEditor />);

    await userEvent.click(await screen.findByRole("button", { name: /replay macro/i }));
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        "request_replay",
        expect.objectContaining({ id: "2000", loopForever: true, traceId: expect.any(String) }),
      );
    });

    await userEvent.click(screen.getByTitle("Click to rename"));
    const titleInput = screen.getByRole("textbox");
    await userEvent.clear(titleInput);
    await userEvent.type(titleInput, "Keyboard workflow{Enter}");
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        "update_recording_name",
        expect.objectContaining({
          id: "2000",
          name: "Keyboard workflow",
          traceId: expect.any(String),
        }),
      );
    });
    expect(screen.getByTitle("Click to rename")).toHaveTextContent("Keyboard workflow");
  });

  it("hands the selected recording to the main window for replay", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    // Newest (id 2000) is auto-selected, so its player shows the Replay button.
    fake.recordings = [makeInputOnlyRecording("1000", "Alpha"), makeRecording("2000", "Beta")];

    render(<StudioEditor />);
    const replayButton = await screen.findByRole("button", { name: /replay macro/i });
    await userEvent.click(replayButton);

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        "request_replay",
        expect.objectContaining({ id: "2000", loopForever: true, traceId: expect.any(String) }),
      );
    });
  });

  it("passes the Studio loop toggle to the replay request", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    fake.recordings = [makeRecording("2000", "Beta")];

    render(<StudioEditor />);
    await userEvent.click(await screen.findByRole("button", { name: /loop on/i }));
    await userEvent.click(screen.getByRole("button", { name: /replay macro/i }));

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        "request_replay",
        expect.objectContaining({ id: "2000", loopForever: false, traceId: expect.any(String) }),
      );
    });
  });

  it("loads, resets, saves, and replays the non-destructive trim range", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    fake.recordings = [makeInputOnlyRecording("2000", "Trimmed input")];
    const doc = defaultProjectDoc();
    doc.trimRegions = [{ id: "recording-trim", startMs: 200, endMs: 900 }];
    fake.projects.set("2000", doc);

    render(<StudioEditor />);
    const reset = await screen.findByRole("button", { name: /reset trim/i });
    expect(screen.getByText(/kept 0:00\.20–0:00\.90/i)).toBeInTheDocument();
    await userEvent.click(reset);

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        "studio_save_project",
        expect.objectContaining({
          recordingId: "2000",
          doc: expect.objectContaining({ trimRegions: [] }),
          traceId: expect.any(String),
        }),
      );
    });

    await userEvent.click(screen.getByRole("button", { name: /replay macro/i }));
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        "request_replay",
        expect.objectContaining({
          id: "2000",
          trimStartMs: 0,
          trimEndMs: 1200,
          traceId: expect.any(String),
        }),
      );
    });
  });

  it("keeps the perception UI paused: no load_observations invoke, no panel", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const recording = makeRecording("2000", "Beta");
    recording.targets = [
      {
        id: "t1",
        name: "Submit",
        modality: "visual",
        region: { x: 0.1, y: 0.1, w: 0.2, h: 0.1 },
        kind: { type: "TextOcr", expect: null },
        created_at: 1,
      },
    ];
    fake.recordings = [recording];

    render(<StudioEditor />);
    await screen.findByRole("button", { name: /replay macro/i });

    expect(screen.queryByRole("button", { name: "Test frame" })).not.toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalledWith(
      "load_observations",
      expect.objectContaining({ recordingId: "2000" }),
    );
  });

  it("deletes a recording via its row delete button (two-click confirm)", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    fake.recordings = [makeRecording("1000", "Alpha"), makeRecording("2000", "Beta")];

    render(<StudioEditor />);
    // Alpha isn't the auto-selected clip, so open the folder menu to reach it.
    await userEvent.click(await screen.findByRole("button", { name: /recordings/i }));
    const alpha = await screen.findByText("Alpha");
    const row = alpha.closest(".rm-row") as HTMLElement;
    const deleteButton = within(row).getByRole("button", { name: /delete recording/i });

    // First click arms; the second confirms the delete.
    await userEvent.click(deleteButton);
    await userEvent.click(deleteButton);

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        "delete_recording",
        expect.objectContaining({ id: "1000", traceId: expect.any(String) }),
      );
    });
    await waitFor(() => {
      expect(screen.queryByText("Alpha")).not.toBeInTheDocument();
    });
    // Beta is selected, so its name is in both the list and the title bar.
    expect(screen.getAllByText("Beta").length).toBeGreaterThan(0);
  });

  it("shows the player by default, and switches to the macros view via the title-bar Macro editor button", async () => {
    fake.recordings = [makeRecording("2000", "Beta")];
    render(<StudioEditor />);

    // Default view is the player.
    await screen.findByRole("button", { name: /replay macro/i });

    // Exactly one title-bar toggle named "Macro editor" (distinct from the
    // menu's "Macros" picker button, which only exists inside the macros view).
    const toggles = screen.getAllByRole("button", { name: /^macro editor$/i });
    expect(toggles).toHaveLength(1);
    await userEvent.click(toggles[0]);

    // Player is gone; the macro editor is up (Run/Add Segment are its markers).
    expect(screen.queryByRole("button", { name: /replay macro/i })).not.toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /run/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /add segment/i })).toBeInTheDocument();
  });

  it("does not have two buttons sharing the name 'Macros' in the macros view", async () => {
    fake.recordings = [makeRecording("2000", "Beta")];
    render(<StudioEditor />);
    await screen.findByRole("button", { name: /^macro editor$/i });

    await userEvent.click(screen.getByRole("button", { name: /^macro editor$/i }));
    await screen.findByRole("button", { name: /run/i });

    // The only button named exactly "Macros" is the menu's picker — resolving
    // it must not throw on multiple matches.
    expect(screen.getByRole("button", { name: /^macros$/i })).toBeInTheDocument();
  });

  it("toggles back to the player when the Macro editor button is clicked again", async () => {
    fake.recordings = [makeRecording("2000", "Beta")];
    render(<StudioEditor />);
    await screen.findByRole("button", { name: /replay macro/i });

    const macrosButton = screen.getByRole("button", { name: /^macro editor$/i });
    await userEvent.click(macrosButton);
    await screen.findByRole("button", { name: /run/i });

    await userEvent.click(macrosButton);
    expect(await screen.findByRole("button", { name: /replay macro/i })).toBeInTheDocument();
  });
});
