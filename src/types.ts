export enum RecordingStatus {
  Idle = "idle",
  Recording = "recording",
  Stopped = "stopped",
}

export enum InputEventType {
  KeyPress = "KeyPress",
  KeyRelease = "KeyRelease",
  KeyCombo = "KeyCombo",
  ButtonPress = "ButtonPress",
  ButtonRelease = "ButtonRelease",
  MouseMove = "MouseMove",
}

export type InputEvent = 
  | { type: InputEventType.KeyPress; key: string; timestamp: number }
  | { type: InputEventType.KeyRelease; key: string; timestamp: number }
  | { type: InputEventType.KeyCombo; char: string; key: string; modifiers: string[]; timestamp: number }
  | { type: InputEventType.ButtonPress; button: string; x: number; y: number; timestamp: number }
  | { type: InputEventType.ButtonRelease; button: string; x: number; y: number; timestamp: number }
  | { type: InputEventType.MouseMove; x: number; y: number; timestamp: number };

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
  fps: number; // UI offers 15, 30, 60 — parser accepts any u32
  quality: CaptureQuality;
  audio: boolean;
}

export interface AppSettings {
  capture: CaptureSettings;
}

export interface Recording {
  id: string;
  name: string;
  events: InputEvent[];
  created_at: number;
  playback_speed: number;
  video?: VideoMetadata;
}
