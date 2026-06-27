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

  it("renames the title inline: click → edit → Enter commits", async () => {
    const onTitleChange = vi.fn();
    render(<StudioTitleBar title="Old name" editable onTitleChange={onTitleChange} />);

    // Click the title to start editing; an input takes over with the text.
    await userEvent.click(screen.getByRole("button", { name: "Old name" }));
    const input = screen.getByRole("textbox");
    expect(input).toHaveValue("Old name");

    await userEvent.clear(input);
    await userEvent.type(input, "New name{Enter}");
    expect(onTitleChange).toHaveBeenCalledWith("New name");
  });

  it("does not commit on Escape, and is not editable without the flag", async () => {
    const onTitleChange = vi.fn();
    const { rerender } = render(
      <StudioTitleBar title="Keep me" editable onTitleChange={onTitleChange} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Keep me" }));
    await userEvent.type(screen.getByRole("textbox"), " edited{Escape}");
    expect(onTitleChange).not.toHaveBeenCalled();

    // Without `editable`, the title is plain text (no button to click).
    rerender(<StudioTitleBar title="Studio" />);
    expect(screen.queryByRole("button", { name: "Studio" })).not.toBeInTheDocument();
  });
});
