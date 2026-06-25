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
      default:
        return undefined;
    }
  }),
  convertFileSrc: vi.fn((p: string) => `asset://${p}`),
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
    // jsdom doesn't implement scrollIntoView; the selection effect calls it.
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("shows the empty state when there are no recordings", async () => {
    render(<StudioEditor />);
    await waitFor(() => {
      expect(screen.getByText(/no recordings yet/i)).toBeInTheDocument();
    });
  });

  it("lists recordings that have video", async () => {
    fake.recordings = [makeRecording("1000", "Older clip"), makeRecording("2000", "Newer clip")];
    render(<StudioEditor />);
    await waitFor(() => {
      expect(screen.getByText("Newer clip")).toBeInTheDocument();
    });
    expect(screen.getByText("Older clip")).toBeInTheDocument();
  });

  it("hands the selected recording to the main window for replay", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    // Newest (id 2000) is auto-selected, so its player shows the Replay button.
    fake.recordings = [makeRecording("1000", "Alpha"), makeRecording("2000", "Beta")];

    render(<StudioEditor />);
    const replayButton = await screen.findByRole("button", { name: /replay macro/i });
    await userEvent.click(replayButton);

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("request_replay", { id: "2000" });
    });
  });

  it("deletes a recording via its row delete button (two-click confirm)", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    fake.recordings = [makeRecording("1000", "Alpha"), makeRecording("2000", "Beta")];

    render(<StudioEditor />);
    const alpha = await screen.findByText("Alpha");
    const row = alpha.closest(".rec-row") as HTMLElement;
    const deleteButton = within(row).getByRole("button", { name: /delete recording/i });

    // First click arms; the second confirms the delete.
    await userEvent.click(deleteButton);
    await userEvent.click(deleteButton);

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("delete_recording", { id: "1000" });
    });
    await waitFor(() => {
      expect(screen.queryByText("Alpha")).not.toBeInTheDocument();
    });
    expect(screen.getByText("Beta")).toBeInTheDocument();
  });
});
