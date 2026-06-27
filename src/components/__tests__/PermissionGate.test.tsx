import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

const win = vi.hoisted(() => ({
  close: vi.fn(),
  minimize: vi.fn(),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => win,
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
    expect(win.close).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole("button", { name: /minimize window/i }));
    expect(win.minimize).toHaveBeenCalledTimes(1);
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
