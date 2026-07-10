import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { PerceptionOverlay } from "./PerceptionOverlay";
import type { PerceptionTarget, TextSpan } from "@/types";

const rect = { left: 10, top: 20, width: 200, height: 100 };

const target: PerceptionTarget = {
  id: "t1",
  name: "Play button",
  modality: "visual",
  region: { x: 0.25, y: 0.5, w: 0.5, h: 0.25 },
  kind: { type: "ColorSample", rgb: [0, 0, 0], tolerance: 10 },
  created_at: 0,
};

describe("PerceptionOverlay", () => {
  it("positions a target box in px against the rect, labeled with its name", () => {
    render(<PerceptionOverlay rect={rect} targets={[target]} spans={[]} />);
    const label = screen.getByText("Play button");
    const box = label.parentElement as HTMLElement;
    expect(box.style.left).toBe("50px");
    expect(box.style.top).toBe("50px");
    expect(box.style.width).toBe("100px");
    expect(box.style.height).toBe("25px");
  });

  it("renders an OCR span box per TextSpan", () => {
    const spans: TextSpan[] = [
      { text: "Hello", region: { x: 0.1, y: 0.2, w: 0.3, h: 0.1 }, confidence: 0.9 },
    ];
    const { container } = render(<PerceptionOverlay rect={rect} targets={[]} spans={spans} />);
    // Locate the span box by its computed position (fractional region * rect).
    const box = Array.from(container.querySelectorAll("div")).find(
      (el) => el.style.left === "20px" && el.style.top === "20px",
    );
    expect(box).toBeTruthy();
    expect(box?.style.width).toBe("60px");
    expect(box?.style.height).toBe("10px");
  });
});
