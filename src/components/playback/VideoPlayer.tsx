import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

export interface VideoPlayerHandle {
  seekSeconds: (s: number) => void;
  play: () => Promise<void>;
  pause: () => void;
}

interface Props {
  src: string;
  onTimeUpdate: (seconds: number) => void;
  onDurationChange?: (durationSec: number) => void;
  onError?: (err: string) => void;
}

export const VideoPlayer = forwardRef<VideoPlayerHandle, Props>(
  ({ src, onTimeUpdate, onDurationChange, onError }, ref) => {
    const videoRef = useRef<HTMLVideoElement>(null);

    useImperativeHandle(ref, () => ({
      seekSeconds: (s: number) => {
        if (videoRef.current) videoRef.current.currentTime = s;
      },
      play: async () => {
        await videoRef.current?.play();
      },
      pause: () => {
        videoRef.current?.pause();
      },
    }));

    useEffect(() => {
      const v = videoRef.current;
      if (!v) return;
      const onTime = () => onTimeUpdate(v.currentTime);
      const onDur = () => onDurationChange?.(v.duration);
      const onErr = () => onError?.("video decode failed");
      v.addEventListener("timeupdate", onTime);
      v.addEventListener("loadedmetadata", onDur);
      v.addEventListener("error", onErr);
      return () => {
        v.removeEventListener("timeupdate", onTime);
        v.removeEventListener("loadedmetadata", onDur);
        v.removeEventListener("error", onErr);
      };
    }, [onTimeUpdate, onDurationChange, onError]);

    return (
      <video
        ref={videoRef}
        src={src}
        controls
        className="w-full h-full bg-black rounded-lg"
      />
    );
  },
);

VideoPlayer.displayName = "VideoPlayer";
