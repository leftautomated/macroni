import type { InputEvent, MacroNode, Recording } from "@/types";

/** Events whose timestamp, relative to `basis`, falls within [startMs, endMs] (inclusive). */
export function eventsInRange(
  events: InputEvent[],
  basis: number,
  startMs: number,
  endMs: number,
): InputEvent[] {
  return events.filter((e) => {
    const rel = e.timestamp - basis;
    return rel >= startMs && rel <= endMs;
  });
}

/** The zero point that recording events' timestamps are relative to. */
export function segmentBasis(recording: Recording): number {
  return recording.video?.start_ms ?? recording.created_at;
}

/**
 * Builds a Segment MacroNode from a [startMs, endMs] range (relative to the
 * recording's basis). Rounds to whole milliseconds — a fractional-second
 * input (e.g. 1.001) would otherwise produce a non-integer ms value that
 * fails to deserialize into Rust's i64/u64 fields on the backend.
 */
export function segmentNodeFromRange(
  recording: Recording,
  startMs: number,
  endMs: number,
): MacroNode {
  const rStart = Math.round(startMs);
  const rEnd = Math.round(endMs);
  const events = eventsInRange(recording.events, segmentBasis(recording), rStart, rEnd);
  return {
    id: crypto.randomUUID(),
    kind: {
      type: "Segment",
      events,
      speed: 1,
      provenance: { recording_id: recording.id, start_ms: rStart, end_ms: rEnd },
    },
    x: 40,
    y: 40,
  };
}
