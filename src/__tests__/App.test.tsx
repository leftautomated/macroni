import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Mock the Tauri APIs before importing App so the module picks them up.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    // load_recordings is called by useRecordings on mount; return empty list.
    if (cmd === "load_recordings") return [];
    if (cmd === "check_screen_recording_permission") return true;
    if (cmd === "check_accessibility_permission") return true;
    return undefined;
  }),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => {
    // Tauri's listen returns an unlisten function.
    return () => {};
  }),
}));

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: vi.fn(() => ({
    setSize: vi.fn(async () => {}),
  })),
}));

import App from "@/App";

describe("App (integration root)", () => {
  beforeEach(() => {
    // jsdom doesn't implement ResizeObserver; useAutoResize uses it.
    if (!("ResizeObserver" in globalThis)) {
      (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
    }
  });

  it("renders the recording controls in the header", async () => {
    render(<App />);
    expect(await screen.findByRole("button", { name: /start/i })).toBeInTheDocument();
  });

  it("starts collapsed — the tabs are not visible until expanded", async () => {
    render(<App />);
    await screen.findByRole("button", { name: /start/i });
    // Live Events / Settings are inside the expandable panel.
    expect(screen.queryByText("Live Events")).not.toBeInTheDocument();
    expect(screen.queryByText("Settings")).not.toBeInTheDocument();
  });

  it("opens the panel and shows the Live Events and Settings tabs when expanded", async () => {
    render(<App />);
    const expandButton = await screen.findByRole("button", { name: /^expand$/i });
    await userEvent.click(expandButton);
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /live events/i })).toBeInTheDocument();
      expect(screen.getByRole("tab", { name: /^settings$/i })).toBeInTheDocument();
    });
    // Recordings browsing moved to the Studio — no Recordings tab here anymore.
    expect(screen.queryByRole("tab", { name: /^recordings$/i })).not.toBeInTheDocument();
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
});
