import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MacroToolbar } from "./MacroToolbar";

function renderToolbar(overrides: Partial<Parameters<typeof MacroToolbar>[0]> = {}) {
  const onSave = vi.fn();
  const onRun = vi.fn();
  const onStop = vi.fn();
  render(
    <MacroToolbar
      dirty={false}
      valid={true}
      runState="idle"
      onSave={onSave}
      onRun={onRun}
      onStop={onStop}
      {...overrides}
    />,
  );
  return { onSave, onRun, onStop };
}

describe("MacroToolbar", () => {
  it("disables Run without rendering the removed validity strip when the chain isn't valid", () => {
    renderToolbar({ valid: false });
    expect(screen.getByRole("button", { name: /run/i })).toBeDisabled();
    expect(screen.queryByText(/chain/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/invalid graph/i)).not.toBeInTheDocument();
  });

  it("enables Run when valid and idle, and calls onRun when clicked", async () => {
    const { onRun } = renderToolbar({ valid: true, runState: "idle" });
    const runButton = screen.getByRole("button", { name: /run/i });
    expect(runButton).toBeEnabled();
    await userEvent.click(runButton);
    expect(onRun).toHaveBeenCalledTimes(1);
  });

  it("hides Stop while idle", () => {
    renderToolbar({ runState: "idle" });
    expect(screen.queryByRole("button", { name: /stop/i })).not.toBeInTheDocument();
  });

  it("disables Run and shows Stop while running", async () => {
    const { onStop } = renderToolbar({ valid: true, runState: "running" });
    expect(screen.getByRole("button", { name: /run/i })).toBeDisabled();
    const stopButton = screen.getByRole("button", { name: /stop/i });
    expect(stopButton).toBeInTheDocument();
    await userEvent.click(stopButton);
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("describes unsaved changes without rendering a visual status dot", () => {
    const { rerender } = render(
      <MacroToolbar
        dirty={true}
        valid={true}
        runState="idle"
        onSave={() => {}}
        onRun={() => {}}
        onStop={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "Save unsaved changes" })).toBeInTheDocument();
    expect(document.querySelector(".mt-dirty-dot")).not.toBeInTheDocument();

    rerender(
      <MacroToolbar
        dirty={false}
        valid={true}
        runState="idle"
        onSave={() => {}}
        onRun={() => {}}
        onStop={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
  });

  it("calls onSave when Save is clicked", async () => {
    const { onSave } = renderToolbar({ dirty: true });
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("disables Run via runDisabledReason even when valid and idle, using it as the title", () => {
    renderToolbar({ valid: true, runState: "idle", runDisabledReason: "Save before running." });
    const runButton = screen.getByRole("button", { name: /run/i });
    expect(runButton).toBeDisabled();
    expect(runButton).toHaveAttribute("title", "Save before running.");
  });
});
