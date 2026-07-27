import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RuleDeck } from "@/components/studio/macros/RuleDeck";
import { InputEventType, type MacroRule } from "@/types";

function rule(id: string, overrides: Partial<MacroRule> = {}): MacroRule {
  return {
    id,
    trigger: {
      id: `t-${id}`,
      name: "climb the stairs",
      modality: "visual",
      region: { x: 0.4, y: 0.2, w: 0.2, h: 0.05 },
      kind: { type: "TextOcr", expect: "climb the stairs" },
      created_at: 1,
    },
    action: {
      type: "PlayInputs",
      events: [
        { type: InputEventType.KeyPress, key: "A", timestamp: 0 },
        { type: InputEventType.KeyPress, key: "B", timestamp: 8200 },
      ],
      speed: 1,
      provenance: null,
    },
    enabled: true,
    anchor: { recording_id: "rec1", timestamp_ms: 100 },
    ...overrides,
  };
}

const noHandlers = {
  onAddRule: vi.fn(),
  onSelect: vi.fn(),
  onToggle: vi.fn(),
  onDelete: vi.fn(),
  onMove: vi.fn(),
};

describe("RuleDeck", () => {
  it("renders one sentence card per rule", () => {
    render(
      <RuleDeck
        rules={[rule("r1"), rule("r2", { action: { type: "Stop" } })]}
        liveRuleId={null}
        failed={null}
        running={false}
        draft={null}
        {...noHandlers}
      />,
    );
    expect(screen.getAllByText(/"climb the stairs"/)).toHaveLength(2);
    expect(screen.getByText("2 events · 8.2s")).toBeInTheDocument();
    expect(screen.getByText("Stop macro")).toBeInTheDocument();
  });

  it("renders NO empty-state copy when there are no rules — only the Add affordance", () => {
    const { container } = render(
      <RuleDeck
        rules={[]}
        liveRuleId={null}
        failed={null}
        running={false}
        draft={null}
        {...noHandlers}
      />,
    );
    expect(screen.getByRole("button", { name: /add rule/i })).toBeInTheDocument();
    // The deck body contains nothing but the add button — no copy nodes.
    expect(container.querySelectorAll(".rc-root")).toHaveLength(0);
    expect(container.textContent?.toLowerCase()).not.toContain("no rules");
    expect(container.textContent?.toLowerCase()).not.toContain("empty");
  });

  it("wires card actions: select, toggle, delete, move", () => {
    const onSelect = vi.fn();
    const onToggle = vi.fn();
    const onDelete = vi.fn();
    const onMove = vi.fn();
    render(
      <RuleDeck
        rules={[rule("r1"), rule("r2")]}
        liveRuleId={null}
        failed={null}
        running={false}
        draft={null}
        onAddRule={vi.fn()}
        onSelect={onSelect}
        onToggle={onToggle}
        onDelete={onDelete}
        onMove={onMove}
      />,
    );
    fireEvent.click(screen.getAllByText(/"climb the stairs"/)[0]);
    expect(onSelect).toHaveBeenCalledWith("r1");
    fireEvent.click(screen.getAllByRole("switch", { name: /enabled/i })[0]);
    expect(onToggle).toHaveBeenCalledWith("r1");
    fireEvent.click(screen.getAllByRole("button", { name: /delete rule/i })[1]);
    expect(onDelete).toHaveBeenCalledWith("r2");
    fireEvent.click(screen.getAllByRole("button", { name: /move down/i })[0]);
    expect(onMove).toHaveBeenCalledWith("r1", 1);
  });

  it("disables move-up on the first card and move-down on the last", () => {
    render(
      <RuleDeck
        rules={[rule("r1"), rule("r2")]}
        liveRuleId={null}
        failed={null}
        running={false}
        draft={null}
        {...noHandlers}
      />,
    );
    expect(screen.getAllByRole("button", { name: /move up/i })[0]).toBeDisabled();
    expect(screen.getAllByRole("button", { name: /move down/i })[1]).toBeDisabled();
  });

  it("flags live, failed, and watching states on the right cards", () => {
    render(
      <RuleDeck
        rules={[rule("r1"), rule("r2")]}
        liveRuleId="r1"
        failed={{ ruleId: "r2", reason: "evaluation-error: boom" }}
        running={true}
        draft={null}
        {...noHandlers}
      />,
    );
    const cards = document.querySelectorAll(".rc-root");
    expect(cards[0].getAttribute("data-live")).toBe("true");
    expect(cards[1].getAttribute("data-failed")).toBe("true");
    expect(screen.getByText(/evaluation-error: boom/)).toBeInTheDocument();
  });

  it("renders the draft slot above the cards when provided", () => {
    render(
      <RuleDeck
        rules={[rule("r1")]}
        liveRuleId={null}
        failed={null}
        running={false}
        draft={<div data-testid="draft" />}
        {...noHandlers}
      />,
    );
    expect(screen.getByTestId("draft")).toBeInTheDocument();
  });
});
