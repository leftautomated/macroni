import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider, useTheme } from "./theme-provider";

function ThemeHarness() {
  const { setTheme, theme } = useTheme();
  return (
    <>
      <output>{theme}</output>
      <button type="button" onClick={() => setTheme("light")}>
        Light
      </button>
      <button type="button" onClick={() => setTheme("system")}>
        System
      </button>
    </>
  );
}

describe("ThemeProvider", () => {
  let systemDark = false;
  let onSystemChange: (() => void) | null = null;

  beforeEach(() => {
    localStorage.clear();
    document.documentElement.className = "";
    systemDark = false;
    onSystemChange = null;
    window.matchMedia = vi.fn().mockImplementation(() => ({
      get matches() {
        return systemDark;
      },
      addEventListener: (_event: string, listener: () => void) => {
        onSystemChange = listener;
      },
      removeEventListener: vi.fn(),
    }));
  });

  it("applies and persists a selected theme", async () => {
    render(
      <ThemeProvider storageKey="theme-test">
        <ThemeHarness />
      </ThemeProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Light" }));

    expect(document.documentElement).toHaveClass("light");
    expect(document.documentElement.style.colorScheme).toBe("light");
    expect(localStorage.getItem("theme-test")).toBe("light");
  });

  it("tracks operating-system changes while System is selected", async () => {
    render(
      <ThemeProvider storageKey="theme-test">
        <ThemeHarness />
      </ThemeProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "System" }));
    expect(document.documentElement).toHaveClass("light");

    systemDark = true;
    act(() => onSystemChange?.());
    expect(document.documentElement).toHaveClass("dark");
  });
});
