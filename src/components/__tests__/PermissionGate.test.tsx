import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

const win = vi.hoisted(() => ({
  close: vi.fn(),
  hide: vi.fn(),
  minimize: vi.fn(),
}));
const toPng = vi.hoisted(() => vi.fn(() => Promise.resolve("data:image/png;base64,cm93")));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => win,
}));
vi.mock("html-to-image", () => ({
  toPng,
}));

import { PermissionGate } from "@/components/PermissionGate";

describe("PermissionGate", () => {
  it("shows granted and missing permissions", async () => {
    const openAccessibility = vi.fn();
    const openScreenRecording = vi.fn();

    render(
      <PermissionGate
        accessibility={true}
        screenRecording={false}
        activeAssistantPanel={null}
        onOpenAccessibilitySettings={openAccessibility}
        onOpenScreenRecordingSettings={openScreenRecording}
      />,
    );

    expect(screen.getByRole("heading", { name: "Enable Macroni" })).toBeInTheDocument();
    expect(screen.getByText("Done")).toBeInTheDocument();

    await userEvent.click(screen.getAllByRole("button", { name: "Allow" })[0]);

    expect(openAccessibility).not.toHaveBeenCalled();
    expect(openScreenRecording).toHaveBeenCalledTimes(1);
  });

  it("wires the traffic lights to the current window", async () => {
    win.close.mockClear();
    win.hide.mockClear();
    win.minimize.mockClear();

    render(
      <PermissionGate
        accessibility={false}
        screenRecording={false}
        activeAssistantPanel={null}
        onOpenAccessibilitySettings={vi.fn()}
        onOpenScreenRecordingSettings={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /close window/i }));
    expect(win.hide).toHaveBeenCalledTimes(1);
    expect(win.close).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: /minimize window/i }));
    expect(win.minimize).toHaveBeenCalledTimes(1);
  });

  it("uses the supplied close handler before falling back to window hide", async () => {
    win.hide.mockClear();
    const onClose = vi.fn();

    render(
      <PermissionGate
        accessibility={false}
        screenRecording={false}
        activeAssistantPanel={null}
        onClose={onClose}
        onOpenAccessibilitySettings={vi.fn()}
        onOpenScreenRecordingSettings={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /close window/i }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(win.hide).not.toHaveBeenCalled();
  });

  it("reveals permanently mounted traffic light glyphs without changing geometry", async () => {
    const { container } = render(
      <PermissionGate
        accessibility={false}
        screenRecording={false}
        activeAssistantPanel={null}
        onOpenAccessibilitySettings={vi.fn()}
        onOpenScreenRecordingSettings={vi.fn()}
      />,
    );
    const lights = container.querySelector(".permission-traffic-lights");

    expect(lights).toBeInstanceOf(HTMLElement);
    expect(container.querySelectorAll(".permission-traffic-glyph")).toHaveLength(3);
    expect(lights).not.toHaveClass("is-hovered");

    await userEvent.hover(lights as HTMLElement);
    expect(container.querySelectorAll(".permission-traffic-glyph")).toHaveLength(3);
    expect(lights).toHaveClass("is-hovered");

    await userEvent.unhover(lights as HTMLElement);
    expect(container.querySelectorAll(".permission-traffic-glyph")).toHaveLength(3);
    expect(lights).not.toHaveClass("is-hovered");
  });

  it("passes the clicked row rect when opening System Settings", async () => {
    const openAccessibility = vi.fn();

    render(
      <PermissionGate
        accessibility={false}
        screenRecording={false}
        activeAssistantPanel={null}
        onOpenAccessibilitySettings={openAccessibility}
        onOpenScreenRecordingSettings={vi.fn()}
      />,
    );

    await userEvent.click(screen.getAllByRole("button", { name: "Allow" })[0]);

    expect(openAccessibility).toHaveBeenCalledWith(
      expect.objectContaining({
        width: expect.any(Number),
        height: expect.any(Number),
        sourceImageDataUrl: "data:image/png;base64,cm93",
      }),
    );
  });

  it("shows a System Settings placeholder for the active permission", () => {
    render(
      <PermissionGate
        accessibility={false}
        screenRecording={false}
        activeAssistantPanel="accessibility"
        onOpenAccessibilitySettings={vi.fn()}
        onOpenScreenRecordingSettings={vi.fn()}
      />,
    );

    expect(screen.getByText("Complete in System Settings")).toBeInTheDocument();
  });
});
