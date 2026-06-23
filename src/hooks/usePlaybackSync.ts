import { useCallback, useEffect, useRef, useState } from "react";
import type { InputEvent, VideoMetadata } from "@/types";

/**
 * Binary search for the event whose timestamp is <= `currentMs`.
 * Events are sorted by timestamp ascending by construction.
 * Returns -1 if the list is empty, 0 if `currentMs` is before the first event.
 */
export function findActiveEventIndex(events: InputEvent[], currentMs: number): number {
  if (events.length === 0) return -1;
  if (currentMs < events[0].timestamp) return 0;
  let lo = 0;
  let hi = events.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (events[mid].timestamp <= currentMs) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

interface SyncState {
  currentMs: number;
  activeIndex: number;
  videoTimeMs: number;
}

interface UsePlaybackSyncArgs {
  events: InputEvent[];
  video: VideoMetadata | null | undefined;
}

/**
 * Maps a video's playback position to the active recorded-event index so an
 * event list can highlight along with the video. Time is anchored at `startMs`
 * (the video's start), and event timestamps are absolute, so the active event
 * is the last one at or before `startMs + videoTime`.
 */
export function usePlaybackSync({ events, video }: UsePlaybackSyncArgs) {
  const startMs = video?.start_ms ?? events[0]?.timestamp ?? 0;
  const [state, setState] = useState<SyncState>({
    currentMs: startMs,
    activeIndex: -1,
    videoTimeMs: 0,
  });
  const userScrolledAt = useRef<number>(0);

  const onVideoTime = useCallback(
    (videoSeconds: number) => {
      const videoTimeMs = videoSeconds * 1000;
      const absoluteMs = startMs + videoTimeMs;
      setState({
        currentMs: absoluteMs,
        activeIndex: findActiveEventIndex(events, absoluteMs),
        videoTimeMs,
      });
    },
    [events, startMs],
  );

  // Video time (seconds, relative to start) for a given event index.
  const eventVideoSeconds = useCallback(
    (index: number): number => {
      const e = events[index];
      if (!e) return 0;
      return Math.max(0, e.timestamp - startMs) / 1000;
    },
    [events, startMs],
  );

  const noteUserScroll = useCallback(() => {
    userScrolledAt.current = Date.now();
  }, []);

  const shouldAutoScroll = useCallback(() => {
    return Date.now() - userScrolledAt.current > 1500;
  }, []);

  // When events first arrive (recording switch), seed the active index.
  useEffect(() => {
    if (state.activeIndex === -1 && events.length > 0) {
      setState((s) => ({ ...s, activeIndex: findActiveEventIndex(events, s.currentMs) }));
    }
  }, [events, state.activeIndex, state.currentMs]);

  return {
    ...state,
    startMs,
    onVideoTime,
    eventVideoSeconds,
    noteUserScroll,
    shouldAutoScroll,
  } as const;
}
