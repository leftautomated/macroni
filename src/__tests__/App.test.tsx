import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Mock the Tauri APIs before importing App so the module picks them up.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    // load_recordings is called by useRecordings on mount; return empty list.
    if (cmd === "load_recordings") return [];
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
    // Live Events / Recordings / Settings are inside the expandable panel.
    expect(screen.queryByText("Live Events")).not.toBeInTheDocument();
    expect(screen.queryByText("Recordings")).not.toBeInTheDocument();
    expect(screen.queryByText("Settings")).not.toBeInTheDocument();
  });

  it("opens the panel and shows the three tabs when the expand toggle is clicked", async () => {
    render(<App />);
    const expandButton = await screen.findByRole("button", { name: /^expand$/i });
    await userEvent.click(expandButton);
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /live events/i })).toBeInTheDocument();
      expect(screen.getByRole("tab", { name: /^recordings$/i })).toBeInTheDocument();
      expect(screen.getByRole("tab", { name: /^settings$/i })).toBeInTheDocument();
    });
  });
});
