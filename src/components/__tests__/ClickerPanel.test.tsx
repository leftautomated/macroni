import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ClickerPanel } from "@/components/ClickerPanel";

const config = {
  button: "left" as const,
  clicksPerPeriod: 10,
  period: "second" as const,
};

describe("ClickerPanel", () => {
  it("presents the two compact click controls with safe defaults", () => {
    render(
      <ClickerPanel
        config={config}
        error={null}
        onChange={vi.fn()}
        onStart={vi.fn()}
        onStop={vi.fn()}
        status="idle"
      />,
    );

    expect(screen.getByRole("combobox", { name: "Mouse button" })).toHaveTextContent("Left");
    expect(screen.getByRole("spinbutton", { name: "Clicks per second" })).toHaveValue(10);
    expect(screen.getByRole("combobox", { name: "Click period" })).toHaveTextContent("second");
  });

  it("starts and then exposes a single stop action while armed", async () => {
    const onStart = vi.fn();
    const onStop = vi.fn();
    const { rerender } = render(
      <ClickerPanel
        config={config}
        error={null}
        onChange={vi.fn()}
        onStart={onStart}
        onStop={onStop}
        status="idle"
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Start clicking" }));
    expect(onStart).toHaveBeenCalledOnce();

    rerender(
      <ClickerPanel
        config={config}
        error={null}
        onChange={vi.fn()}
        onStart={onStart}
        onStop={onStop}
        status="arming"
      />,
    );
    expect(screen.getByText("Starts in 3 seconds…")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Stop clicking" }));
    expect(onStop).toHaveBeenCalledOnce();

    rerender(
      <ClickerPanel
        config={config}
        error={null}
        onChange={vi.fn()}
        onStart={onStart}
        onStop={onStop}
        status="stopping"
      />,
    );
    expect(screen.getByRole("button", { name: "Stopping…" })).toBeDisabled();
  });
});
