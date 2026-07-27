import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TriggerPicker } from "@/components/studio/macros/TriggerPicker";
import type { TextSpan } from "@/types";

const spans: TextSpan[] = [
  {
    text: "climb the stairs",
    region: { x: 0.4, y: 0.2, w: 0.2, h: 0.05 },
    confidence: 0.9,
  },
  {
    text: "SCORE 120",
    region: { x: 0.05, y: 0.05, w: 0.15, h: 0.04 },
    confidence: 0.8,
  },
];

describe("TriggerPicker", () => {
  it("shows a scanning state while spans are null", () => {
    render(<TriggerPicker spans={null} onPickSpan={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText(/scanning/i)).toBeInTheDocument();
  });

  it("renders a positioned, clickable box per span", () => {
    const onPickSpan = vi.fn();
    render(<TriggerPicker spans={spans} onPickSpan={onPickSpan} onCancel={vi.fn()} />);
    const box = screen.getByRole("button", { name: /climb the stairs/i });
    expect(box.style.left).toBe("40%");
    expect(box.style.top).toBe("20%");
    expect(box.style.width).toBe("20%");
    expect(box.style.height).toBe("5%");
    fireEvent.click(box);
    expect(onPickSpan).toHaveBeenCalledWith(spans[0]);
  });

  it("offers drag-a-box guidance when OCR found nothing", () => {
    render(<TriggerPicker spans={[]} onPickSpan={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText(/drag a box/i)).toBeInTheDocument();
  });

  it("cancel chip fires onCancel", () => {
    const onCancel = vi.fn();
    render(<TriggerPicker spans={spans} onPickSpan={vi.fn()} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalled();
  });
});
