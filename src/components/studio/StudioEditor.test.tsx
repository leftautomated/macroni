import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Recording } from "@/types";

// In-memory backend the mocked Tauri commands talk to.
const fake = { recordings: [] as Recording[] };

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    switch (cmd) {
      case "load_recordings":
        return [...fake.recordings];
      case "get_app_data_dir":
        return "/data";
      case "delete_recording":
        fake.recordings = fake.recordings.filter((r) => r.id !== args?.id);
        return undefined;
      case "load_observations":
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

describe("StudioEditor (recordings browser)", () => {
  beforeEach(() => {
    fake.recordings = [];
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

  it("hands the selected recording to the main window for replay", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    // Newest (id 2000) is auto-selected, so its player shows the Replay button.
    fake.recordings = [makeRecording("1000", "Alpha"), makeRecording("2000", "Beta")];

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
});
