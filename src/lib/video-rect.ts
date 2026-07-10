export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Contain-fit rect of a video's displayed pixels inside a container box. */
export function videoDisplayRect(
  container: { width: number; height: number },
  video: { width: number; height: number },
): Rect {
  if (container.width <= 0 || container.height <= 0 || video.width <= 0 || video.height <= 0) {
    return { left: 0, top: 0, width: 0, height: 0 };
  }
  const scale = Math.min(container.width / video.width, container.height / video.height);
  const width = video.width * scale;
  const height = video.height * scale;
  return {
    left: (container.width - width) / 2,
    top: (container.height - height) / 2,
    width,
    height,
  };
}
