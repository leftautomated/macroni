import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// The bar drives the borderless window through getCurrentWindow().
const win = {
  close: vi.fn(),
  minimize: vi.fn(),
  toggleMaximize: vi.fn(),
};
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => win,
}));

import { StudioTitleBar } from "@/components/studio/StudioTitleBar";

describe("StudioTitleBar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the centered title", () => {
    render(<StudioTitleBar title="My Recording" />);
    expect(screen.getByText("My Recording")).toBeInTheDocument();
  });

  it("closes / minimizes / maximizes the window via the traffic lights", async () => {
    render(<StudioTitleBar title="Studio" />);

    await userEvent.click(screen.getByRole("button", { name: /close window/i }));
    expect(win.close).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole("button", { name: /minimize window/i }));
    expect(win.minimize).toHaveBeenCalledTimes(1);

    // Green is "expand" — a zoom for now (toggleMaximize), not native fullscreen.
    await userEvent.click(screen.getByRole("button", { name: /expand window/i }));
    expect(win.toggleMaximize).toHaveBeenCalledTimes(1);
  });
});
