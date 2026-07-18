import { eventsInRange, segmentBasis } from "@/lib/macro-segment";
import type { Recording } from "@/types";
import type { ProjectDoc } from "@/types/project";

export interface TrimRange {
  a: number;
  b: number;
}

export const RECORDING_TRIM_ID = "recording-trim";

export function fullTrim(durationMs: number): TrimRange {
  return { a: 0, b: Math.max(0, durationMs) };
}

export function clampTrim(trim: TrimRange, durationMs: number): TrimRange {
  const duration = Math.max(0, durationMs);
  const a = Math.min(duration, Math.max(0, Math.min(trim.a, trim.b)));
  const b = Math.min(duration, Math.max(a, Math.max(trim.a, trim.b)));
  return { a, b };
}

export function trimFromProject(doc: ProjectDoc, durationMs: number): TrimRange {
  const saved =
    doc.trimRegions.find((region) => region.id === RECORDING_TRIM_ID) ?? doc.trimRegions[0];
  return saved ? clampTrim({ a: saved.startMs, b: saved.endMs }, durationMs) : fullTrim(durationMs);
}

export function projectWithTrim(doc: ProjectDoc, trim: TrimRange, durationMs: number): ProjectDoc {
  const clamped = clampTrim(trim, durationMs);
  const isFull = clamped.a <= 0 && clamped.b >= Math.max(0, durationMs);
  return {
    ...doc,
    trimRegions: isFull
      ? []
      : [
          {
            id: RECORDING_TRIM_ID,
            startMs: Math.round(clamped.a),
            endMs: Math.round(clamped.b),
          },
        ],
  };
}

/** Return a replay copy while leaving the original recording and events intact. */
export function recordingWithinTrim(recording: Recording, trim: TrimRange): Recording {
  return {
    ...recording,
    events: eventsInRange(
      recording.events,
      segmentBasis(recording),
      Math.round(trim.a),
      Math.round(trim.b),
    ),
  };
}
