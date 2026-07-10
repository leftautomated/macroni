import { describe, expect, it } from "vitest";
import { waitNodeFromTarget } from "./macro-wait";
import type { PerceptionTarget } from "@/types";

const target = (kind: PerceptionTarget["kind"]): PerceptionTarget => ({
  id: "t1",
  name: "n",
  modality: "visual",
  region: { x: 0, y: 0, w: 1, h: 1 },
  kind,
  created_at: 1,
});

describe("waitNodeFromTarget", () => {
  it("wraps a text target with defaults", () => {
    const node = waitNodeFromTarget(target({ type: "TextOcr", expect: "Go" }));
    expect(node.kind.type).toBe("WaitFor");
    if (node.kind.type !== "WaitFor") throw new Error();
    expect(node.kind.timeout_ms).toBe(10000);
    expect(node.kind.poll_interval_ms).toBe(500);
    expect(node.kind.target.kind).toEqual({ type: "TextOcr", expect: "Go" });
  });
  it("wraps a template target and honors a custom timeout", () => {
    const node = waitNodeFromTarget(
      target({ type: "TemplateMatch", image: "assets/x.png", threshold: 0.8, source_px: [10, 10] }),
      8000,
    );
    if (node.kind.type !== "WaitFor") throw new Error();
    expect(node.kind.timeout_ms).toBe(8000);
    expect(node.kind.target.kind.type).toBe("TemplateMatch");
  });
  it("wraps a color target", () => {
    const node = waitNodeFromTarget(target({ type: "ColorSample", rgb: [1, 2, 3], tolerance: 10 }));
    if (node.kind.type !== "WaitFor") throw new Error();
    expect(node.kind.target.kind).toEqual({ type: "ColorSample", rgb: [1, 2, 3], tolerance: 10 });
  });
});
