export enum RecordingStatus {
  Idle = "idle",
  Recording = "recording",
  Processing = "processing",
  Stopped = "stopped",
}

export enum InputEventType {
  KeyPress = "KeyPress",
  KeyRelease = "KeyRelease",
  KeyCombo = "KeyCombo",
  ButtonPress = "ButtonPress",
  ButtonRelease = "ButtonRelease",
  MouseMove = "MouseMove",
  Scroll = "Scroll",
  SpaceSwitch = "SpaceSwitch",
}

export type InputEvent =
  | { type: InputEventType.KeyPress; key: string; timestamp: number }
  | { type: InputEventType.KeyRelease; key: string; timestamp: number }
  | {
      type: InputEventType.KeyCombo;
      char: string;
      key: string;
      modifiers: string[];
      timestamp: number;
    }
  | { type: InputEventType.ButtonPress; button: string; x: number; y: number; timestamp: number }
  | { type: InputEventType.ButtonRelease; button: string; x: number; y: number; timestamp: number }
  | { type: InputEventType.MouseMove; x: number; y: number; timestamp: number }
  | { type: InputEventType.Scroll; delta_x: number; delta_y: number; timestamp: number }
  | {
      type: InputEventType.SpaceSwitch;
      direction: "left" | "right";
      count: number;
      timestamp: number;
    };

export interface VideoMetadata {
  path: string;
  start_ms: number;
  duration_ms: number;
  width: number;
  height: number;
  fps: number;
  has_audio: boolean;
}

export type CaptureQuality = "low" | "med" | "high";

export interface CaptureSettings {
  video: boolean;
  fps: number; // UI offers 15, 30, 60 — parser accepts any u32
  quality: CaptureQuality;
  audio: boolean;
}

export interface PerceptionSettings {
  continuous_ocr: boolean;
}

export interface AppSettings {
  capture: CaptureSettings;
  perception: PerceptionSettings;
}

export interface LogFileSummary {
  path: string;
  bytes: number;
  modifiedMs?: number | null;
}

export interface DiagnosticsSnapshot {
  appVersion: string;
  os: string;
  arch: string;
  isRecording: boolean;
  isPlaying: boolean;
  appLogDir?: string | null;
  crashLogPath?: string | null;
  crashLogBytes?: number | null;
  logFiles: LogFileSummary[];
  recentLogLines: string[];
}

export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type TargetKind =
  | { type: "TextOcr"; expect?: string | null }
  | { type: "TemplateMatch"; image: string; threshold: number; source_px: [number, number] }
  | { type: "ColorSample"; rgb: [number, number, number]; tolerance: number };

export interface PerceptionTarget {
  id: string;
  name: string;
  modality: "visual";
  region?: Region | null;
  kind: TargetKind;
  created_at: number;
}

export interface TextSpan {
  text: string;
  region: Region;
  confidence: number;
}

export type ObservationResult =
  | { type: "Text"; spans: TextSpan[] }
  | { type: "Template"; matched: boolean; location?: Region | null; score: number }
  | { type: "Color"; rgb: [number, number, number]; matched: boolean };

export interface Observation {
  target_id?: string | null;
  timestamp_ms: number;
  result: ObservationResult;
}

export interface Recording {
  id: string;
  name: string;
  events: InputEvent[];
  created_at: number;
  playback_speed: number;
  /** Units of Scroll event deltas. The store normalizes to "pixels" on load. */
  scroll_unit?: "lines" | "pixels";
  video?: VideoMetadata;
  targets?: PerceptionTarget[];
}

export interface MacroEdge {
  from: string;
  to: string;
}

export interface MacroProvenance {
  recording_id: string;
  start_ms: number;
  end_ms: number;
}

export type MacroNodeKind =
  | {
      type: "Segment";
      events: InputEvent[];
      speed: number;
      provenance?: MacroProvenance | null;
    }
  | {
      type: "WaitFor";
      target: PerceptionTarget;
      timeout_ms: number;
      poll_interval_ms: number;
    };

export interface MacroNode {
  id: string;
  kind: MacroNodeKind;
  x: number;
  y: number;
}

export interface MacroDoc {
  id: string;
  name: string;
  nodes: MacroNode[];
  edges: MacroEdge[];
  created_at: number;
}
