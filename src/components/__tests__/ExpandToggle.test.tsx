import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ExpandToggle } from "../ExpandToggle";

describe("ExpandToggle", () => {
  it("shows the collapse hint when expanded and the expand hint when collapsed", () => {
    const { rerender } = render(<ExpandToggle isExpanded={false} onToggle={() => {}} />);
    expect(screen.getByRole("button")).toHaveAttribute("title", "Expand");

    rerender(<ExpandToggle isExpanded={true} onToggle={() => {}} />);
    expect(screen.getByRole("button")).toHaveAttribute("title", "Collapse");
  });

  it("invokes onToggle exactly once per click", async () => {
    const onToggle = vi.fn();
    render(<ExpandToggle isExpanded={false} onToggle={onToggle} />);
    await userEvent.click(screen.getByRole("button"));
    await userEvent.click(screen.getByRole("button"));
    expect(onToggle).toHaveBeenCalledTimes(2);
  });
});
