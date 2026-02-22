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

export interface Keystroke {
  key: string;
  timestamp: number;
}

export interface MouseClick {
  button: string;
  x: number;
  y: number;
  timestamp: number;
}

export interface MousePosition {
  x: number;
  y: number;
  timestamp: number;
}

export type InputEvent = 
  | { type: InputEventType.KeyPress; key: string; timestamp: number }
  | { type: InputEventType.KeyRelease; key: string; timestamp: number }
  | { type: InputEventType.KeyCombo; char: string; key: string; modifiers: string[]; timestamp: number }
  | { type: InputEventType.ButtonPress; button: string; x: number; y: number; timestamp: number }
  | { type: InputEventType.ButtonRelease; button: string; x: number; y: number; timestamp: number }
  | { type: InputEventType.MouseMove; x: number; y: number; timestamp: number };

export interface Recording {
  id: string;
  name: string;
  events: InputEvent[];
  created_at: number;
  playback_speed: number;
}
