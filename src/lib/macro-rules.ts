import type { LoopRegion } from "@/components/studio/StudioTimeline";
import { eventsInRange, segmentBasis } from "@/lib/macro-segment";
import type { MacroRule, PerceptionTarget, Recording, TextSpan } from "@/types";

export interface RulesDoc {
  rules: MacroRule[];
}

const SPAN_PAD = 0.01;

/** TextOcr trigger scoped to a detected span's box, padded and clamped. */
export function spanTrigger(span: TextSpan): PerceptionTarget {
  const x = Math.max(0, span.region.x - SPAN_PAD);
  const y = Math.max(0, span.region.y - SPAN_PAD);
  const w = Math.min(1 - x, span.region.w + 2 * SPAN_PAD);
  const h = Math.min(1 - y, span.region.h + 2 * SPAN_PAD);
  return {
    id: crypto.randomUUID(),
    name: span.text,
    modality: "visual",
    region: { x, y, w, h },
    kind: { type: "TextOcr", expect: span.text },
    created_at: Date.now(),
  };
}

export function playInputsRule(
  trigger: PerceptionTarget,
  recording: Recording,
  anchorMs: number,
  startMs: number,
  endMs: number,
): MacroRule {
  const rStart = Math.round(startMs);
  const rEnd = Math.round(endMs);
  const events = eventsInRange(recording.events, segmentBasis(recording), rStart, rEnd);
  return {
    id: crypto.randomUUID(),
    trigger,
    action: {
      type: "PlayInputs",
      events,
      speed: 1,
      provenance: { recording_id: recording.id, start_ms: rStart, end_ms: rEnd },
    },
    enabled: true,
    anchor: { recording_id: recording.id, timestamp_ms: Math.round(anchorMs) },
  };
}

export function stopRule(
  trigger: PerceptionTarget,
  recordingId: string,
  anchorMs: number,
): MacroRule {
  return {
    id: crypto.randomUUID(),
    trigger,
    action: { type: "Stop" },
    enabled: true,
    anchor: { recording_id: recordingId, timestamp_ms: Math.round(anchorMs) },
  };
}

export function ruleSummary(rule: MacroRule): string {
  if (rule.action.type === "Stop") return "Stop macro";
  const { events } = rule.action;
  let dur = 0;
  if (events.length >= 2) {
    const first = events[0];
    const last = events[events.length - 1];
    dur = Math.round(((last.timestamp - first.timestamp) / 1000) * 10) / 10;
  }
  return `${events.length} events · ${dur}s`;
}

export function triggerLabel(target: PerceptionTarget): string {
  if (target.kind.type === "TextOcr" && target.kind.expect) return `"${target.kind.expect}"`;
  return target.name || target.id;
}

export function isRunnableRulesDoc(doc: RulesDoc): boolean {
  const enabled = doc.rules.filter((r) => r.enabled);
  if (enabled.length === 0) return false;
  return enabled.every((r) => r.action.type !== "PlayInputs" || r.action.events.length > 0);
}

export function moveRule<T extends RulesDoc>(doc: T, ruleId: string, delta: -1 | 1): T {
  const index = doc.rules.findIndex((r) => r.id === ruleId);
  const to = index + delta;
  if (index === -1 || to < 0 || to >= doc.rules.length) return doc;
  const rules = [...doc.rules];
  const [moved] = rules.splice(index, 1);
  rules.splice(to, 0, moved);
  return { ...doc, rules };
}

export function toggleRule<T extends RulesDoc>(doc: T, ruleId: string): T {
  return {
    ...doc,
    rules: doc.rules.map((r) => (r.id === ruleId ? { ...r, enabled: !r.enabled } : r)),
  };
}

export function removeRule<T extends RulesDoc>(doc: T, ruleId: string): T {
  return { ...doc, rules: doc.rules.filter((r) => r.id !== ruleId) };
}

/**
 * Pre-selected action range for a new rule: from the anchor to the next
 * rule anchor on the same recording, else the recording end. Null when the
 * anchor leaves no room (at/after the end).
 */
export function defaultActionRange(
  doc: RulesDoc,
  recordingId: string,
  anchorMs: number,
  durationMs: number,
): LoopRegion | null {
  const a = Math.round(anchorMs);
  const laterAnchors = doc.rules
    .map((r) => r.anchor)
    .filter((an): an is NonNullable<typeof an> => !!an && an.recording_id === recordingId)
    .map((an) => an.timestamp_ms)
    .filter((ms) => ms > a);
  const b = Math.round(laterAnchors.length > 0 ? Math.min(...laterAnchors) : durationMs);
  return b > a ? { a, b } : null;
}

/** Timeline tick markers for every rule anchored on `recordingId`. */
export function anchorTicks(
  doc: RulesDoc,
  recordingId: string,
): Array<{ ms: number; label: string }> {
  return doc.rules
    .filter((r) => r.anchor?.recording_id === recordingId)
    .map((r) => ({
      ms: r.anchor?.timestamp_ms ?? 0,
      label: triggerLabel(r.trigger),
    }))
    .sort((x, y) => x.ms - y.ms);
}
