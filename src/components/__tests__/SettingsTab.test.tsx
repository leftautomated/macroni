import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings } from "@/types";

const settingsState = vi.hoisted(() => ({
  settings: {
    capture: { video: true, fps: 30, quality: "med", audio: true },
    perception: { continuous_ocr: false },
  } as AppSettings,
  update: vi.fn(),
}));

vi.mock("@/hooks/useAppSettings", () => ({
  useAppSettings: () => ({
    settings: settingsState.settings,
    update: settingsState.update,
  }),
}));

vi.mock("@/components/theme-provider", () => ({
  useTheme: () => ({ theme: "dark", setTheme: vi.fn() }),
}));

vi.mock("@/hooks/usePermissionStatus", () => ({
  usePermissionStatus: () => ({
    state: { accessibility: true, screenRecording: true },
    openAccessibilitySettings: vi.fn(),
    openScreenRecordingSettings: vi.fn(),
  }),
}));

vi.mock("@/components/DiagnosticsPanel", () => ({
  DiagnosticsPanel: () => <div>diagnostics stub</div>,
}));

import { SettingsTab } from "@/components/SettingsTab";

describe("SettingsTab", () => {
  beforeEach(() => {
    settingsState.settings = {
      capture: { video: true, fps: 30, quality: "med", audio: true },
      perception: { continuous_ocr: false },
    };
    settingsState.update.mockReset();
  });

  it("turning off screen video clears continuous OCR", async () => {
    settingsState.settings = {
      capture: { video: true, fps: 30, quality: "med", audio: true },
      perception: { continuous_ocr: true },
    };

    render(<SettingsTab />);
    await userEvent.click(screen.getByRole("switch", { name: /record screen video/i }));

    expect(settingsState.update).toHaveBeenCalledWith({
      capture: { video: false, fps: 30, quality: "med", audio: true },
      perception: { continuous_ocr: false },
    });
  });

  it("disables video-dependent controls when screen video is off", () => {
    settingsState.settings = {
      capture: { video: false, fps: 30, quality: "med", audio: true },
      perception: { continuous_ocr: true },
    };

    render(<SettingsTab />);

    expect(screen.getByRole("button", { name: "15" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "30" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "60" })).toBeDisabled();
    expect(screen.getByRole("switch", { name: /capture system audio/i })).toBeDisabled();
    expect(screen.getByRole("switch", { name: /continuous text scan/i })).toBeDisabled();
    expect(screen.getByRole("switch", { name: /continuous text scan/i })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });
});
