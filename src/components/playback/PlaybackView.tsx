import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Recording } from "@/types";
import { VideoPlayer, VideoPlayerHandle } from "./VideoPlayer";
import { SyncedEventList } from "./SyncedEventList";
import { EventTimeline } from "./EventTimeline";
import { usePlaybackSync } from "@/hooks/usePlaybackSync";
import { useVideoAssetUrl } from "@/hooks/useVideoAssetUrl";

interface Props {
  recordingId: string;
}

export function PlaybackView({ recordingId }: Props) {
  const [recording, setRecording] = useState<Recording | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const videoRef = useRef<VideoPlayerHandle>(null);

  useEffect(() => {
    invoke<Recording[]>("load_recordings")
      .then((all) => {
        const r = all.find((x) => x.id === recordingId);
        if (!r) {
          setLoadError("Recording not found");
          return;
        }
        setRecording(r);
      })
      .catch((e) => setLoadError(String(e)));
  }, [recordingId]);

  const events = recording?.events ?? [];
  const video = recording?.video ?? null;
  const sync = usePlaybackSync({ events, video });
  const { url: videoUrl, error: videoUrlError } = useVideoAssetUrl(video);

  useEffect(() => {
    videoRef.current?.seekSeconds(sync.videoTimeMs / 1000);
  }, [sync.videoTimeMs]);

  if (loadError) {
    return (
      <div className="h-screen flex items-center justify-center text-destructive">
        {loadError}
      </div>
    );
  }
  if (!recording) {
    return <div className="h-screen flex items-center justify-center">Loading…</div>;
  }

  const videoMissing = !video || !videoUrl || !!videoUrlError;
  const durationMs =
    video?.duration_ms ??
    (events.length > 0 ? events[events.length - 1].timestamp - sync.startMs : 0);

  return (
    <div className="h-screen flex flex-col bg-background text-foreground p-4 gap-3">
      <div className="flex-1 grid grid-cols-5 gap-3 min-h-0">
        <div className="col-span-3 min-h-0">
          {videoMissing ? (
            <div className="w-full h-full flex items-center justify-center border rounded-lg bg-muted/20">
              <p className="text-sm text-muted-foreground">
                Video file not found — event list only
              </p>
            </div>
          ) : (
            <VideoPlayer
              ref={videoRef}
              src={videoUrl!}
              onTimeUpdate={sync.onVideoTime}
              onError={() => {
                /* handled by videoMissing check */
              }}
            />
          )}
        </div>
        <div className="col-span-2 min-h-0">
          <SyncedEventList
            events={events}
            activeIndex={sync.activeIndex}
            onClickEvent={sync.seekToEvent}
            onUserScroll={sync.noteUserScroll}
            autoScrollEnabled={sync.shouldAutoScroll()}
          />
        </div>
      </div>
      <EventTimeline
        events={events}
        startMs={sync.startMs}
        durationMs={durationMs}
        activeIndex={sync.activeIndex}
        onSeek={sync.seekToMs}
      />
      <div className="text-xs text-muted-foreground">
        {recording.name} — {events.length} events —{" "}
        {video ? `${(video.duration_ms / 1000).toFixed(1)}s` : "no video"}
      </div>
    </div>
  );
}
