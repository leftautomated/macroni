/**
 * Acceptance specs (vitest+jsdom layer).
 *
 * These tests describe end-to-end user-visible behaviour at the React+hooks
 * level. They mock the Tauri IPC surface so the React side renders end-to-end
 * without a real Tauri runtime. True cross-process E2E (Rust ↔ JS over real
 * IPC) is deferred — see docs/adrs/0007-acceptance-specs.md.
 *
 * Scope rule: each scenario must describe a user-visible flow ("when X
 * happens, then Y is shown") and assert against the rendered DOM, not
 * component internals.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// In-memory store the mocked Tauri commands talk to. Reset before each test.
type Recording = {
  id: string;
  name: string;
  events: unknown[];
  created_at: number;
  playback_speed: number;
  video: null;
};
const fakeBackend = {
  recordings: [] as Recording[],
  startCalls: 0,
  stopCalls: 0,
  reset() {
    this.recordings = [];
    this.startCalls = 0;
    this.stopCalls = 0;
  },
};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    switch (cmd) {
      case "load_recordings":
        return [...fakeBackend.recordings];
      case "check_screen_recording_permission":
      case "check_accessibility_permission":
        return true;
      case "start_recording":
        fakeBackend.startCalls += 1;
        return `rec-${Date.now()}`;
      case "stop_recording":
        fakeBackend.stopCalls += 1;
        return { id: `rec-${Date.now()}`, events: [], video: null };
      case "save_recording": {
        const recording: Recording = {
          id: String(args?.id ?? `rec-${Date.now()}`),
          name: String(args?.name ?? "Untitled"),
          events: Array.isArray(args?.events) ? (args.events as unknown[]) : [],
          created_at: Date.now(),
          playback_speed: 1.0,
          video: null,
        };
        fakeBackend.recordings.push(recording);
        return recording;
      }
      case "stop_playback":
      case "toggle_visibility":
      case "set_window_size":
        return undefined;
      default:
        return undefined;
    }
  }),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: vi.fn(() => ({
    setSize: vi.fn(async () => {}),
  })),
}));

import App from "@/App";

describe("Acceptance: recording flow", () => {
  beforeEach(() => {
    fakeBackend.reset();
    if (!("ResizeObserver" in globalThis)) {
      (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
    }
  });

  afterEach(() => {
    // Symmetric cleanup so a test that throws mid-run can't leave seeded
    // recordings visible to the next test.
    fakeBackend.reset();
  });

  it("opens the Studio (where recordings now live) via the header button", async () => {
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

  it("clicking Start dispatches start_recording to the backend", async () => {
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: /start/i }));

    await waitFor(() => {
      expect(fakeBackend.startCalls).toBeGreaterThanOrEqual(1);
    });
  });
});
