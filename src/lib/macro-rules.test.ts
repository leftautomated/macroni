import { describe, expect, it } from "vitest";
import {
  anchorTicks,
  defaultActionRange,
  isRunnableRulesDoc,
  moveRule,
  playInputsRule,
  removeRule,
  ruleSummary,
  spanTrigger,
  stopRule,
  toggleRule,
  triggerLabel,
} from "@/lib/macro-rules";
import { InputEventType, type MacroRule, type Recording, type TextSpan } from "@/types";

const span: TextSpan = {
  text: "climb the stairs",
  region: { x: 0.4, y: 0.2, w: 0.2, h: 0.04 },
  confidence: 0.95,
};

const recording: Recording = {
  id: "rec1",
  name: "run",
  created_at: 0,
  playback_speed: 1,
  events: [
    { type: InputEventType.KeyPress, key: "A", timestamp: 1000 },
    { type: InputEventType.KeyPress, key: "B", timestamp: 2000 },
    { type: InputEventType.KeyPress, key: "C", timestamp: 9000 },
  ],
  video: {
    path: "v.mp4",
    duration_ms: 10000,
    fps: 30,
    width: 100,
    height: 100,
    start_ms: 0,
    has_audio: true,
  },
};

describe("spanTrigger", () => {
  it("builds a TextOcr target scoped to the padded span box", () => {
    const t = spanTrigger(span);
    expect(t.kind).toEqual({ type: "TextOcr", expect: "climb the stairs" });
    expect(t.name).toBe("climb the stairs");
    // Padded by 0.01 on each side, clamped to [0,1].
    expect(t.region).toEqual({ x: 0.39, y: 0.19, w: 0.22, h: 0.06 });
  });

  it("clamps padding at the frame edges", () => {
    const edge = spanTrigger({ ...span, region: { x: 0, y: 0.99, w: 1, h: 0.01 } });
    expect(edge.region?.x).toBe(0);
    expect(edge.region?.y).toBeCloseTo(0.98);
    expect((edge.region?.x ?? 0) + (edge.region?.w ?? 0)).toBeLessThanOrEqual(1);
    expect((edge.region?.y ?? 0) + (edge.region?.h ?? 0)).toBeLessThanOrEqual(1);
  });
});

describe("rule builders", () => {
  it("playInputsRule carves events in [startMs, endMs] with provenance and anchor", () => {
    const rule = playInputsRule(spanTrigger(span), recording, 500, 1000, 2500);
    expect(rule.action.type).toBe("PlayInputs");
    if (rule.action.type !== "PlayInputs") return;
    expect(rule.action.events).toHaveLength(2);
    expect(rule.action.provenance).toEqual({ recording_id: "rec1", start_ms: 1000, end_ms: 2500 });
    expect(rule.anchor).toEqual({ recording_id: "rec1", timestamp_ms: 500 });
    expect(rule.enabled).toBe(true);
  });

  it("playInputsRule rounds fractional ms", () => {
    const rule = playInputsRule(spanTrigger(span), recording, 500.4, 999.6, 2500.2);
    expect(rule.anchor?.timestamp_ms).toBe(500);
    if (rule.action.type !== "PlayInputs") return;
    expect(rule.action.provenance?.start_ms).toBe(1000);
    expect(rule.action.provenance?.end_ms).toBe(2500);
  });

  it("stopRule has a Stop action and an anchor", () => {
    const rule = stopRule(spanTrigger(span), "rec1", 700);
    expect(rule.action).toEqual({ type: "Stop" });
    expect(rule.anchor).toEqual({ recording_id: "rec1", timestamp_ms: 700 });
  });
});

describe("summaries", () => {
  it("summarizes PlayInputs as count and duration", () => {
    const rule = playInputsRule(spanTrigger(span), recording, 0, 1000, 9000);
    expect(ruleSummary(rule)).toBe("3 events · 8s");
  });
  it("summarizes Stop", () => {
    expect(ruleSummary(stopRule(spanTrigger(span), "rec1", 0))).toBe("Stop macro");
  });
  it("labels a text trigger by its expect text", () => {
    expect(triggerLabel(spanTrigger(span))).toBe('"climb the stairs"');
  });
});

describe("doc utilities", () => {
  const r1 = playInputsRule(spanTrigger(span), recording, 100, 1000, 2500);
  const r2 = stopRule(spanTrigger(span), "rec1", 5000);
  const doc = { rules: [r1, r2] };

  it("isRunnableRulesDoc requires an enabled rule with events", () => {
    expect(isRunnableRulesDoc({ rules: [] })).toBe(false);
    expect(isRunnableRulesDoc({ rules: [{ ...r1, enabled: false }] })).toBe(false);
    const empty: MacroRule = {
      ...r1,
      action: { type: "PlayInputs", events: [], speed: 1, provenance: null },
    };
    expect(isRunnableRulesDoc({ rules: [empty] })).toBe(false);
    expect(isRunnableRulesDoc(doc)).toBe(true);
  });

  it("moveRule reorders and clamps at the edges", () => {
    expect(moveRule(doc, r2.id, -1).rules.map((r) => r.id)).toEqual([r2.id, r1.id]);
    expect(moveRule(doc, r1.id, -1).rules.map((r) => r.id)).toEqual([r1.id, r2.id]);
  });

  it("toggleRule flips enabled; removeRule drops the rule", () => {
    expect(toggleRule(doc, r1.id).rules[0].enabled).toBe(false);
    expect(removeRule(doc, r1.id).rules.map((r) => r.id)).toEqual([r2.id]);
  });

  it("defaultActionRange runs from the anchor to the next anchor on the same recording", () => {
    expect(defaultActionRange(doc, "rec1", 100, 10000)).toEqual({ a: 100, b: 5000 });
    expect(defaultActionRange(doc, "rec1", 5000, 10000)).toEqual({ a: 5000, b: 10000 });
    expect(defaultActionRange(doc, "rec1", 9999.4, 10000)).toEqual({ a: 9999, b: 10000 });
    // Anchor at the very end → no valid range.
    expect(defaultActionRange(doc, "rec1", 10000, 10000)).toBeNull();
  });

  it("anchorTicks lists anchors for the recording with trigger labels", () => {
    expect(anchorTicks(doc, "rec1")).toEqual([
      { ms: 100, label: '"climb the stairs"' },
      { ms: 5000, label: '"climb the stairs"' },
    ]);
    expect(anchorTicks(doc, "other")).toEqual([]);
  });
});
