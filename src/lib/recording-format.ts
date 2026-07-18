import type { Recording } from "@/types";

/** Human date for a recording's creation time, e.g. "Jun 27, 10:42 AM". */
export function formatWhen(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Compact clip length, e.g. "1m 5s" or "12s". */
export function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

/** Duration covered by a recording, using input timestamps when video is absent. */
export function recordingDuration(rec: Recording): number {
  if (rec.video) return rec.video.duration_ms;
  const first = rec.events[0]?.timestamp;
  const last = rec.events[rec.events.length - 1]?.timestamp;
  if (first === undefined || last === undefined) return 0;
  return Math.max(0, last - first);
}

/** Display name for a recording — its name, or the creation time as a fallback. */
export function recordingTitle(rec: Recording): string {
  return rec.name && rec.name !== "Untitled" ? rec.name : formatWhen(rec.created_at);
}
