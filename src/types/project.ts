// TS mirror of render-core/src/doc.rs — all serde camelCase names preserved.
// Background uses snake_case discriminant tags matching #[serde(rename_all = "snake_case")].

export type Rgba = [number, number, number, number];

export type Background =
  | { type: "solid"; color: Rgba }
  | { type: "linear_gradient"; from: Rgba; to: Rgba; angleDeg: number }
  | { type: "wallpaper"; path: string };

export interface Shadow {
  blurPx: number;
  offsetYPx: number;
  opacity: number;
}

export interface Framing {
  background: Background;
  paddingPx: number;
  borderRadiusPx: number;
  shadow: Shadow;
}

export interface ZoomRegion {
  id: string;
  startMs: number;
  endMs: number;
  scale: number;
  focusCx: number;
  focusCy: number;
  source: "Auto" | "Manual";
}

export interface TrimRegion {
  id: string;
  startMs: number;
  endMs: number;
}

export interface SpeedRegion {
  id: string;
  startMs: number;
  endMs: number;
  speed: number;
}

export interface Media {
  screenMp4: string;
  webcamMp4?: string | null;
  cursorJson?: string | null;
}

export interface ProjectDoc {
  version: number;
  media: Media;
  framing: Framing;
  zoomRegions: ZoomRegion[];
  trimRegions: TrimRegion[];
  speedRegions: SpeedRegion[];
}
