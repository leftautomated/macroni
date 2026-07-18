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

const updaterState = vi.hoisted(() => ({
  availableVersion: null as string | null,
  checkForUpdates: vi.fn(),
  currentVersion: "0.1.7",
  error: null as string | null,
  installUpdate: vi.fn(),
  notes: null as string | null,
  progress: null as number | null,
  status: "up-to-date" as
    | "idle"
    | "checking"
    | "up-to-date"
    | "available"
    | "downloading"
    | "installing"
    | "error",
}));

const themeState = vi.hoisted(() => ({
  setTheme: vi.fn(),
  theme: "dark" as "dark" | "light" | "system",
}));

vi.mock("@/hooks/useAppSettings", () => ({
  useAppSettings: () => ({
    settings: settingsState.settings,
    update: settingsState.update,
  }),
}));

vi.mock("@/hooks/useAppUpdater", () => ({
  useAppUpdater: () => updaterState,
}));

vi.mock("@/components/theme-provider", () => ({
  useTheme: () => themeState,
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
    updaterState.availableVersion = null;
    updaterState.currentVersion = "0.1.7";
    updaterState.error = null;
    updaterState.notes = null;
    updaterState.progress = null;
    updaterState.status = "up-to-date";
    updaterState.checkForUpdates.mockReset();
    updaterState.installUpdate.mockReset();
    themeState.theme = "dark";
    themeState.setTheme.mockReset();
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

  it("wires each appearance button to its theme", async () => {
    render(<SettingsTab />);

    await userEvent.click(screen.getByRole("button", { name: "Light" }));
    await userEvent.click(screen.getByRole("button", { name: "System" }));

    expect(themeState.setTheme).toHaveBeenNthCalledWith(1, "light");
    expect(themeState.setTheme).toHaveBeenNthCalledWith(2, "system");
    expect(screen.getByRole("button", { name: "Dark" })).toHaveAttribute("aria-pressed", "true");
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

  it("installs an available update from settings", async () => {
    updaterState.availableVersion = "0.1.8";
    updaterState.notes = "Faster and more reliable recording.";
    updaterState.status = "available";

    render(<SettingsTab />);

    expect(screen.getByText(/version 0\.1\.8/i)).toBeInTheDocument();
    expect(screen.getByText(/faster and more reliable recording/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /update and restart/i }));

    expect(updaterState.installUpdate).toHaveBeenCalledOnce();
  });

  it("places the update status beside the current version", () => {
    render(<SettingsTab />);

    const version = screen.getByText("Macroni v0.1.7");
    const status = screen.getByText(/you’re up to date/i);

    expect(version.parentElement).toContainElement(status);
    expect(version.parentElement).toHaveClass("st-update-heading");
  });

  it("shows updater download progress", () => {
    updaterState.availableVersion = "0.1.8";
    updaterState.progress = 42;
    updaterState.status = "downloading";

    render(<SettingsTab />);

    expect(screen.getByText(/downloading update… 42%/i)).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: /update download progress/i })).toHaveAttribute(
      "aria-valuenow",
      "42",
    );
  });
});
