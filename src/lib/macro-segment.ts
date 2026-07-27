import type { InputEvent, Recording } from "@/types";

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
