import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Recording } from "@/types";
import { publishReplaySelection } from "@/lib/replay-selection";

const tauri = vi.hoisted(() => {
  type Listener = (event: { payload: unknown }) => void | Promise<void>;
  const state = {
    listeners: new Map<string, Listener>(),
    recordings: [] as unknown[],
  };
  const invoke = vi.fn(async (cmd: string) => {
    // load_recordings is called by useRecordings on mount and by replay events.
    if (cmd === "load_recordings") return [...state.recordings];
    if (cmd === "check_screen_recording_permission") return true;
    if (cmd === "check_accessibility_permission") return true;
    return undefined;
  });
  const listen = vi.fn(async (event: string, handler: Listener) => {
    state.listeners.set(event, handler);
    return () => state.listeners.delete(event);
  });
  return { invoke, listen, state };
});

// Mock the Tauri APIs before importing App so the module picks them up.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauri.invoke,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: tauri.listen,
}));

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: vi.fn(() => ({
    setSize: vi.fn(async () => {}),
  })),
}));

import App from "@/App";

function makeRecording(id: string, loopSpeed = 1): Recording {
  return {
    id,
    name: "Replay target",
    events: [{ type: "KeyPress", key: "KeyA", timestamp: 0 }] as Recording["events"],
    created_at: 1,
    playback_speed: loopSpeed,
  };
}

describe("App (integration root)", () => {
  beforeEach(() => {
    tauri.state.recordings = [];
    tauri.state.listeners.clear();
    localStorage.clear();
    vi.clearAllMocks();

    // jsdom doesn't implement ResizeObserver; useAutoResize uses it.
    if (!("ResizeObserver" in globalThis)) {
      (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
    }
  });

  it("renders separate Record and Play controls in the header", async () => {
    render(<App />);
    expect(await screen.findByRole("button", { name: "Record macro" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Play current macro" })).toBeDisabled();
  });

  it("makes SVG clicks inside the grip start a window drag", async () => {
    const { container } = render(<App />);
    await screen.findByRole("button", { name: "Record macro" });

    expect(container.querySelector('[title="Drag Macroni"]')).toHaveAttribute(
      "data-tauri-drag-region",
      "deep",
    );
  });

  it("is a flat bar — Live Events and Settings moved to the Studio", async () => {
    render(<App />);
    await screen.findByRole("button", { name: "Record macro" });
    expect(screen.queryByText("Live Events")).not.toBeInTheDocument();
    expect(screen.queryByText("Settings")).not.toBeInTheDocument();
    // No expandable panel anymore — there's no expand toggle.
    expect(screen.queryByRole("button", { name: /^expand$/i })).not.toBeInTheDocument();
  });

  it("exposes an Open Studio button in the header", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: /open studio/i }));
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        "focus_studio_window",
        expect.objectContaining({ traceId: expect.any(String) }),
      );
    });
  });

  it("opens the auto clicker and starts it with the compact defaults", async () => {
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Open auto clicker" }));
    await userEvent.click(screen.getByRole("button", { name: "Start clicking" }));

    await waitFor(() => {
      expect(tauri.invoke).toHaveBeenCalledWith(
        "start_clicker",
        expect.objectContaining({
          button: "left",
          clicksPerPeriod: 10,
          period: "second",
          traceId: expect.any(String),
        }),
      );
    });
    expect(screen.getByText("Starts in 3 seconds…")).toBeInTheDocument();
  });

  it("does not subscribe to per-event input traffic (long-recording freeze regression)", async () => {
    render(<App />);
    await screen.findByRole("button", { name: "Record macro" });
    // A long recording delivers tens of thousands of input events; any
    // per-event listener doing React work wedges the webview main thread —
    // and with it the (former) frontend stop path. The bar has no live event
    // view, so the webview must not subscribe at all.
    expect(tauri.state.listeners.has("input-event")).toBe(false);
  });

  it("refreshes recordings when the backend stops a recording (shortcut path)", async () => {
    render(<App />);
    await waitFor(() => {
      expect(tauri.state.listeners.get("recording-stopped")).toBeDefined();
    });
    tauri.invoke.mockClear();

    // Rust stopped + saved the recording itself (webview may have been busy);
    // the frontend only refreshes its list and resets local state.
    await act(async () => {
      await tauri.state.listeners.get("recording-stopped")?.({
        payload: makeRecording("rec-stopped"),
      });
    });

    await waitFor(() => {
      expect(tauri.invoke).toHaveBeenCalledWith(
        "load_recordings",
        expect.objectContaining({ traceId: expect.any(String) }),
      );
    });
    // It must NOT save again — Rust already persisted it.
    expect(tauri.invoke).not.toHaveBeenCalledWith("save_recording", expect.anything());
  });

  it("loads a Studio replay target and waits for the separate Play button", async () => {
    const recording = makeRecording("rec-1");
    tauri.state.recordings = [recording];

    render(<App />);
    await waitFor(() => {
      expect(tauri.state.listeners.get("replay-recording")).toBeDefined();
    });

    await act(async () => {
      await tauri.state.listeners.get("replay-recording")?.({
        payload: { id: "rec-1", loopForever: false },
      });
    });

    expect(tauri.invoke).not.toHaveBeenCalledWith("play_recording", expect.anything());
    await userEvent.click(screen.getByRole("button", { name: "Play current macro" }));

    await waitFor(() => {
      expect(tauri.invoke).toHaveBeenCalledWith(
        "play_recording",
        expect.objectContaining({
          events: recording.events,
          loopForever: false,
          speed: 1,
          traceId: expect.any(String),
        }),
      );
    });
  });

  it("plays the recording currently selected in Studio instead of the latest recording", async () => {
    const current = makeRecording("rec-current");
    current.name = "Current selection";
    current.events = [{ type: "KeyPress", key: "KeyB", timestamp: 0 }] as Recording["events"];
    const latest = makeRecording("rec-latest");
    latest.name = "Latest recording";
    latest.created_at = 2;
    tauri.state.recordings = [latest, current];

    render(<App />);
    await screen.findByRole("button", { name: "Play current macro" });

    act(() => {
      publishReplaySelection(current.id);
    });
    await userEvent.click(screen.getByRole("button", { name: "Play current macro" }));

    await waitFor(() => {
      expect(tauri.invoke).toHaveBeenCalledWith(
        "play_recording",
        expect.objectContaining({
          events: current.events,
          speed: current.playback_speed,
          traceId: expect.any(String),
        }),
      );
    });
  });

  it("replays only events inside the Studio trim without mutating the recording", async () => {
    const recording: Recording = {
      ...makeRecording("rec-trim"),
      created_at: 1000,
      events: [
        { type: "KeyPress", key: "KeyA", timestamp: 1000 },
        { type: "KeyRelease", key: "KeyA", timestamp: 2000 },
        { type: "KeyPress", key: "KeyB", timestamp: 3000 },
      ] as Recording["events"],
    };
    tauri.state.recordings = [recording];
    render(<App />);
    await waitFor(() => expect(tauri.state.listeners.get("replay-recording")).toBeDefined());

    await act(async () => {
      await tauri.state.listeners.get("replay-recording")?.({
        payload: { id: "rec-trim", loopForever: false, trimStartMs: 900, trimEndMs: 1100 },
      });
    });
    await userEvent.click(screen.getByRole("button", { name: "Play current macro" }));

    await waitFor(() => {
      expect(tauri.invoke).toHaveBeenCalledWith(
        "play_recording",
        expect.objectContaining({
          events: [recording.events[1]],
          loopForever: false,
        }),
      );
    });
    expect(recording.events).toHaveLength(3);
  });

  it("plays the newest saved recording from the Play button", async () => {
    const recording = makeRecording("rec-current", 1.5);
    tauri.state.recordings = [recording];

    render(<App />);
    const play = await screen.findByRole("button", { name: "Play current macro" });
    await waitFor(() => expect(play).toBeEnabled());
    await userEvent.click(play);

    await waitFor(() => {
      expect(tauri.invoke).toHaveBeenCalledWith(
        "play_recording",
        expect.objectContaining({
          events: recording.events,
          loopForever: true,
          speed: 1.5,
          traceId: expect.any(String),
        }),
      );
    });
  });
});
