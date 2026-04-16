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
  video: VideoMetadata | null;
}

export function usePlaybackSync({ events, video }: UsePlaybackSyncArgs) {
  const startMs = video?.start_ms ?? (events[0]?.timestamp ?? 0);
  const [state, setState] = useState<SyncState>({ currentMs: startMs, activeIndex: -1, videoTimeMs: 0 });
  const userScrolledAt = useRef<number>(0);

  const onVideoTime = useCallback((videoSeconds: number) => {
    const videoTimeMs = videoSeconds * 1000;
    const absoluteMs = startMs + videoTimeMs;
    setState({
      currentMs: absoluteMs,
      activeIndex: findActiveEventIndex(events, absoluteMs),
      videoTimeMs,
    });
  }, [events, startMs]);

  const seekToEvent = useCallback((index: number) => {
    if (!events[index]) return;
    const absoluteMs = events[index].timestamp;
    const videoTimeMs = Math.max(0, absoluteMs - startMs);
    setState({ currentMs: absoluteMs, activeIndex: index, videoTimeMs });
  }, [events, startMs]);

  const seekToMs = useCallback((absoluteMs: number) => {
    const videoTimeMs = Math.max(0, absoluteMs - startMs);
    setState({ currentMs: absoluteMs, activeIndex: findActiveEventIndex(events, absoluteMs), videoTimeMs });
  }, [events, startMs]);

  const noteUserScroll = useCallback(() => {
    userScrolledAt.current = Date.now();
  }, []);

  const shouldAutoScroll = useCallback(() => {
    return Date.now() - userScrolledAt.current > 1500;
  }, []);

  useEffect(() => {
    if (state.activeIndex === -1 && events.length > 0) {
      setState((s) => ({ ...s, activeIndex: findActiveEventIndex(events, s.currentMs) }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events.length]);

  return {
    ...state,
    startMs,
    onVideoTime,
    seekToEvent,
    seekToMs,
    noteUserScroll,
    shouldAutoScroll,
  } as const;
}
