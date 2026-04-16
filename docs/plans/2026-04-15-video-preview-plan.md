# AUTO-14 Video Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record screen video in sync with the existing event stream and open a separate playback window that shows the video alongside a scrollable event list, with bidirectional scrubbing (click event → seek video; scrub video → highlight event).

**Architecture:** A new Rust `capture` module spawns a `scap`-based screen/audio capture alongside the existing `rdev` listener, encoding to an MP4 per recording. A new Tauri window hosts a React playback UI (video player + event list + scrubber with event markers). Bidirectional sync is owned by a single `usePlaybackSync` hook using `Utc` millisecond timestamps as the shared clock.

**Tech Stack:** Tauri 2, React 19, TypeScript, `scap` (screen+audio capture), `openh264` (encoder), `mp4` (muxer/prober), Vitest (frontend tests), Rust `cargo test`.

**Spec:** [docs/plans/2026-04-15-video-preview-design.md](docs/plans/2026-04-15-video-preview-design.md)

---

## Phase 0 — Prep

### Task 0.1: Bring up test infrastructure

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`
- Create: `src/test/setup.ts`
- Create: `src/hooks/__tests__/smoke.test.ts`

- [ ] **Step 1: Add Vitest + testing-library deps**

```bash
pnpm add -D vitest @vitest/ui @testing-library/react @testing-library/jest-dom @testing-library/user-event jsdom
```

- [ ] **Step 2: Add Vitest script to `package.json` scripts section**

```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    globals: true,
  },
});
```

- [ ] **Step 4: Create `src/test/setup.ts`**

```ts
import "@testing-library/jest-dom/vitest";
```

- [ ] **Step 5: Create smoke test `src/hooks/__tests__/smoke.test.ts`**

```ts
import { describe, it, expect } from "vitest";

describe("smoke", () => {
  it("runs", () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 6: Run tests to verify setup**

Run: `pnpm test`
Expected: 1 test passes.

- [ ] **Step 7: Commit**

```bash
git add package.json pnpm-lock.yaml vitest.config.ts src/test/setup.ts src/hooks/__tests__/smoke.test.ts
git commit -m "chore: add Vitest testing infrastructure"
```

---

### Task 0.2: Update data model types (Rust + TS)

**Files:**
- Modify: `src-tauri/src/types.rs`
- Modify: `src/types.ts`

- [ ] **Step 1: Add `VideoMetadata` and update `Recording` in `src-tauri/src/types.rs`**

Append after the existing `Recording` struct:

```rust
/// Metadata describing a screen recording video file associated with a Recording.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VideoMetadata {
    pub path: String,
    pub start_ms: i64,
    pub duration_ms: i64,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub has_audio: bool,
}
```

Replace the `Recording` struct (lines 50-58) with:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Recording {
    pub id: String,
    pub name: String,
    pub events: Vec<InputEvent>,
    pub created_at: i64,
    #[serde(default = "default_playback_speed")]
    pub playback_speed: f64,
    #[serde(default)]
    pub video: Option<VideoMetadata>,
}
```

- [ ] **Step 2: Add `AppSettings` types in `src-tauri/src/types.rs`**

Append:

```rust
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CaptureQuality {
    Low,
    Med,
    High,
}

impl CaptureQuality {
    pub fn crf(&self) -> u8 {
        match self {
            CaptureQuality::Low => 32,
            CaptureQuality::Med => 28,
            CaptureQuality::High => 23,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CaptureSettings {
    pub fps: u32,
    pub quality: CaptureQuality,
    pub audio: bool,
}

impl Default for CaptureSettings {
    fn default() -> Self {
        Self { fps: 30, quality: CaptureQuality::Med, audio: true }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AppSettings {
    #[serde(default)]
    pub capture: CaptureSettings,
}
```

- [ ] **Step 3: Mirror types in `src/types.ts`**

Append:

```ts
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
  fps: 15 | 30 | 60;
  quality: CaptureQuality;
  audio: boolean;
}

export interface AppSettings {
  capture: CaptureSettings;
}
```

Update the existing `Recording` interface:

```ts
export interface Recording {
  id: string;
  name: string;
  events: InputEvent[];
  created_at: number;
  playback_speed: number;
  video?: VideoMetadata;
}
```

- [ ] **Step 4: Verify it builds**

Run: `cd src-tauri && cargo check`
Expected: no errors.

Run: `pnpm build`
Expected: TypeScript compiles without errors.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/types.rs src/types.ts
git commit -m "feat(types): add VideoMetadata, AppSettings, CaptureSettings"
```

---

## Phase 1 — Settings persistence

### Task 1.1: Rust settings module

**Files:**
- Create: `src-tauri/src/settings.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Create `src-tauri/src/settings.rs`**

```rust
//! Persistence for user-configurable app settings (settings.json in app data dir).

use crate::types::AppSettings;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("settings.json"))
}

pub fn load(app: &AppHandle) -> AppSettings {
    let path = match settings_path(app) {
        Ok(p) => p,
        Err(_) => return AppSettings::default(),
    };
    if !path.exists() {
        return AppSettings::default();
    }
    match std::fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
        Err(_) => AppSettings::default(),
    }
}

pub fn save(app: &AppHandle, settings: &AppSettings) -> Result<(), String> {
    let path = settings_path(app)?;
    let content = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn load_settings(app: AppHandle) -> AppSettings {
    load(&app)
}

#[tauri::command]
pub fn save_settings(app: AppHandle, settings: AppSettings) -> Result<(), String> {
    save(&app, &settings)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::CaptureQuality;

    #[test]
    fn default_settings_have_sensible_values() {
        let s = AppSettings::default();
        assert_eq!(s.capture.fps, 30);
        assert!(matches!(s.capture.quality, CaptureQuality::Med));
        assert!(s.capture.audio);
    }

    #[test]
    fn settings_round_trip_serde() {
        let s = AppSettings::default();
        let json = serde_json::to_string(&s).unwrap();
        let back: AppSettings = serde_json::from_str(&json).unwrap();
        assert_eq!(back.capture.fps, s.capture.fps);
    }

    #[test]
    fn missing_fields_deserialize_to_defaults() {
        let json = "{}";
        let s: AppSettings = serde_json::from_str(json).unwrap();
        assert_eq!(s.capture.fps, 30);
    }
}
```

- [ ] **Step 2: Wire module into `src-tauri/src/lib.rs`**

Near the top (after `mod key_mapping;`), add:
```rust
mod settings;
```

In the `invoke_handler![]` list inside `run()` (lib.rs:780), add:
```rust
settings::load_settings,
settings::save_settings,
```

- [ ] **Step 3: Run tests**

Run: `cd src-tauri && cargo test settings`
Expected: 3 tests pass.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/settings.rs src-tauri/src/lib.rs
git commit -m "feat(settings): add persistent AppSettings via settings.json"
```

---

### Task 1.2: Frontend settings hook

**Files:**
- Create: `src/hooks/useAppSettings.ts`
- Create: `src/hooks/__tests__/useAppSettings.test.ts`

- [ ] **Step 1: Write failing test for `useAppSettings`**

```ts
// src/hooks/__tests__/useAppSettings.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useAppSettings } from "../useAppSettings";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
}));

describe("useAppSettings", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("loads settings on mount", async () => {
    invokeMock.mockResolvedValueOnce({
      capture: { fps: 30, quality: "med", audio: true },
    });
    const { result } = renderHook(() => useAppSettings());
    await waitFor(() => expect(result.current.settings).not.toBeNull());
    expect(result.current.settings?.capture.fps).toBe(30);
  });

  it("persists updates via save_settings", async () => {
    invokeMock.mockResolvedValueOnce({
      capture: { fps: 30, quality: "med", audio: true },
    });
    invokeMock.mockResolvedValueOnce(undefined);
    const { result } = renderHook(() => useAppSettings());
    await waitFor(() => expect(result.current.settings).not.toBeNull());

    await act(async () => {
      await result.current.update({
        capture: { fps: 60, quality: "high", audio: false },
      });
    });

    expect(invokeMock).toHaveBeenCalledWith("save_settings", {
      settings: { capture: { fps: 60, quality: "high", audio: false } },
    });
    expect(result.current.settings?.capture.fps).toBe(60);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test useAppSettings`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `src/hooks/useAppSettings.ts`**

```ts
import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AppSettings } from "@/types";

export const useAppSettings = () => {
  const [settings, setSettings] = useState<AppSettings | null>(null);

  useEffect(() => {
    invoke<AppSettings>("load_settings").then(setSettings).catch((err) => {
      console.error("Failed to load settings:", err);
    });
  }, []);

  const update = useCallback(async (next: AppSettings) => {
    await invoke("save_settings", { settings: next });
    setSettings(next);
  }, []);

  return { settings, update } as const;
};
```

- [ ] **Step 4: Run tests**

Run: `pnpm test useAppSettings`
Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useAppSettings.ts src/hooks/__tests__/useAppSettings.test.ts
git commit -m "feat(settings): add useAppSettings React hook"
```

---

### Task 1.3: Wire capture settings into Settings tab

**Files:**
- Modify: `src/components/SettingsTab.tsx`

- [ ] **Step 1: Extend `SettingsTab` with a Capture section**

Replace the entire content of `src/components/SettingsTab.tsx` with:

```tsx
import { Moon, Sun, Monitor, Keyboard, Shield, Video } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTheme } from "@/components/theme-provider";
import { useAppSettings } from "@/hooks/useAppSettings";
import type { CaptureQuality, CaptureSettings } from "@/types";

const isMac = navigator.userAgent.includes("Mac");
const mod = isMac ? "⌘" : "Ctrl";

const SHORTCUTS = [
  { keys: `${mod} + Shift + R`, description: "Start / stop recording" },
  { keys: `${mod} + R`, description: "Start / stop playback" },
  { keys: `${mod} + M`, description: "Hide / show window" },
] as const;

const FPS_OPTIONS: Array<15 | 30 | 60> = [15, 30, 60];
const QUALITY_OPTIONS: CaptureQuality[] = ["low", "med", "high"];

export const SettingsTab = () => {
  const { setTheme, theme } = useTheme();
  const { settings, update } = useAppSettings();

  const setCapture = (partial: Partial<CaptureSettings>) => {
    if (!settings) return;
    update({ ...settings, capture: { ...settings.capture, ...partial } });
  };

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold">Settings</h3>
        <p className="text-xs text-muted-foreground">Configure application preferences</p>
      </div>
      <div className="h-80 w-full rounded-lg border bg-muted/20 p-4 overflow-y-auto">
        <div className="space-y-5">
          <div className="space-y-2">
            <h4 className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
              <Keyboard className="h-3 w-3" /> Keyboard Shortcuts
            </h4>
            <div className="space-y-1.5">
              {SHORTCUTS.map((s) => (
                <div key={s.keys} className="flex items-center justify-between text-sm">
                  <span className="text-xs text-muted-foreground">{s.description}</span>
                  <kbd className="text-xs font-mono px-2 py-0.5 rounded bg-secondary/50 text-secondary-foreground">{s.keys}</kbd>
                </div>
              ))}
            </div>
          </div>

          <div className="h-px bg-border" />

          <div className="space-y-2">
            <h4 className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
              <Video className="h-3 w-3" /> Video Capture
            </h4>
            {settings ? (
              <div className="space-y-3">
                <div>
                  <p className="text-xs text-muted-foreground mb-1.5">Frame rate</p>
                  <div className="flex gap-2">
                    {FPS_OPTIONS.map((fps) => (
                      <Button
                        key={fps}
                        variant={settings.capture.fps === fps ? "default" : "outline"}
                        size="sm"
                        onClick={() => setCapture({ fps })}
                      >
                        {fps} fps
                      </Button>
                    ))}
                  </div>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground mb-1.5">Quality</p>
                  <div className="flex gap-2">
                    {QUALITY_OPTIONS.map((q) => (
                      <Button
                        key={q}
                        variant={settings.capture.quality === q ? "default" : "outline"}
                        size="sm"
                        onClick={() => setCapture({ quality: q })}
                      >
                        {q.charAt(0).toUpperCase() + q.slice(1)}
                      </Button>
                    ))}
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <p className="text-xs text-muted-foreground">Capture system audio</p>
                  <Button
                    variant={settings.capture.audio ? "default" : "outline"}
                    size="sm"
                    onClick={() => setCapture({ audio: !settings.capture.audio })}
                  >
                    {settings.capture.audio ? "On" : "Off"}
                  </Button>
                </div>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">Loading…</p>
            )}
          </div>

          <div className="h-px bg-border" />

          <div className="space-y-2">
            <h4 className="text-xs font-medium text-muted-foreground">Theme</h4>
            <div className="flex gap-2">
              <Button variant={theme === "light" ? "default" : "outline"} size="sm" onClick={() => setTheme("light")} className="flex items-center gap-2">
                <Sun className="h-3.5 w-3.5" /> Light
              </Button>
              <Button variant={theme === "dark" ? "default" : "outline"} size="sm" onClick={() => setTheme("dark")} className="flex items-center gap-2">
                <Moon className="h-3.5 w-3.5" /> Dark
              </Button>
              <Button variant={theme === "system" ? "default" : "outline"} size="sm" onClick={() => setTheme("system")} className="flex items-center gap-2">
                <Monitor className="h-3.5 w-3.5" /> System
              </Button>
            </div>
          </div>

          <div className="h-px bg-border" />

          <div className="space-y-2">
            <h4 className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
              <Shield className="h-3 w-3" /> Permissions
            </h4>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Macroni needs <span className="font-medium text-foreground">Accessibility</span> permission to capture keyboard and mouse input
              {isMac ? " and " : ""}
              {isMac ? (<span className="font-medium text-foreground">Screen Recording</span>) : null}
              {isMac ? " permission to capture screen video." : "."}
              {isMac ? " Go to System Settings → Privacy & Security to enable Macroni." : " Grant input access in your system settings."}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
```

- [ ] **Step 2: Run app and verify Settings tab shows capture controls**

Run: `pnpm tauri dev`
Manually confirm: Settings tab shows fps/quality/audio controls. Changing them persists (close + reopen app, values retained).

- [ ] **Step 3: Commit**

```bash
git add src/components/SettingsTab.tsx
git commit -m "feat(settings): wire capture settings (fps, quality, audio) into UI"
```

---

## Phase 2 — Capture backend

### Task 2.1: Add capture dependencies

**Files:**
- Modify: `src-tauri/Cargo.toml`

- [ ] **Step 1: Add `scap`, `openh264`, `mp4` to `[dependencies]`**

Append to the `[dependencies]` block in `src-tauri/Cargo.toml`:

```toml
scap = "0.0.8"
openh264 = "0.6"
mp4 = "0.14"
```

- [ ] **Step 2: Verify build**

Run: `cd src-tauri && cargo check`
Expected: dependencies resolve and compile (network required for first fetch).

- [ ] **Step 3: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "chore(deps): add scap, openh264, mp4 for screen capture"
```

---

### Task 2.2: CaptureSink trait + fake sink for tests

**Files:**
- Create: `src-tauri/src/capture.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Create `src-tauri/src/capture.rs` with `CaptureSink` trait and in-memory fake**

```rust
//! Screen capture session abstraction. The `ScreenCaptureSession` orchestrates
//! frame pulls from `scap` and pushes them through a `CaptureSink`. A fake sink
//! backs the unit tests so the capture flow is verifiable without real scap.

use crate::types::{CaptureQuality, VideoMetadata};
use std::sync::{Arc, Mutex};

/// Raw captured frame in BGRA (scap's native format on macOS/Windows).
#[derive(Debug, Clone)]
pub struct Frame {
    pub width: u32,
    pub height: u32,
    pub data: Vec<u8>,
    pub timestamp_ms: i64,
}

/// Sink that receives encoded or raw frames. Implementations write to disk
/// (real encoder) or to memory (test fake).
pub trait CaptureSink: Send {
    fn on_frame(&mut self, frame: &Frame) -> Result<(), String>;
    fn finalize(self: Box<Self>) -> Result<VideoMetadata, String>;
}

/// Test-only sink that collects frames in memory.
#[cfg(test)]
#[derive(Default)]
pub struct FakeSink {
    pub frames: Arc<Mutex<Vec<Frame>>>,
    pub start_ms: i64,
    pub fps: u32,
}

#[cfg(test)]
impl CaptureSink for FakeSink {
    fn on_frame(&mut self, frame: &Frame) -> Result<(), String> {
        self.frames.lock().unwrap().push(frame.clone());
        Ok(())
    }
    fn finalize(self: Box<Self>) -> Result<VideoMetadata, String> {
        let frames = self.frames.lock().unwrap();
        let duration_ms = frames.last().map(|f| f.timestamp_ms - self.start_ms).unwrap_or(0);
        let (width, height) = frames.first().map(|f| (f.width, f.height)).unwrap_or((0, 0));
        Ok(VideoMetadata {
            path: String::from("<fake>"),
            start_ms: self.start_ms,
            duration_ms,
            width,
            height,
            fps: self.fps,
            has_audio: false,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fake_sink_collects_frames_and_reports_duration() {
        let frames_handle: Arc<Mutex<Vec<Frame>>> = Arc::new(Mutex::new(Vec::new()));
        let mut sink = Box::new(FakeSink {
            frames: Arc::clone(&frames_handle),
            start_ms: 1000,
            fps: 30,
        });
        sink.on_frame(&Frame { width: 640, height: 360, data: vec![0; 640 * 360 * 4], timestamp_ms: 1000 }).unwrap();
        sink.on_frame(&Frame { width: 640, height: 360, data: vec![0; 640 * 360 * 4], timestamp_ms: 1033 }).unwrap();
        sink.on_frame(&Frame { width: 640, height: 360, data: vec![0; 640 * 360 * 4], timestamp_ms: 1066 }).unwrap();

        let meta = sink.finalize().unwrap();
        assert_eq!(meta.duration_ms, 66);
        assert_eq!(meta.width, 640);
        assert_eq!(meta.fps, 30);
        assert_eq!(frames_handle.lock().unwrap().len(), 3);
    }
}

/// Unused in FakeSink tests but kept here to silence unused import warnings.
#[allow(dead_code)]
fn _quality_to_crf(q: CaptureQuality) -> u8 {
    q.crf()
}
```

- [ ] **Step 2: Wire module into `src-tauri/src/lib.rs`**

Add near top:
```rust
mod capture;
```

- [ ] **Step 3: Run test**

Run: `cd src-tauri && cargo test capture`
Expected: 1 test passes (`fake_sink_collects_frames_and_reports_duration`).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/capture.rs src-tauri/src/lib.rs
git commit -m "feat(capture): add CaptureSink trait and FakeSink for testing"
```

---

### Task 2.3: H.264 encoder + MP4 muxer (real sink)

**Files:**
- Create: `src-tauri/src/encoder.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Create `src-tauri/src/encoder.rs`**

```rust
//! H.264 encoder + MP4 muxer. Wraps `openh264` for frame encoding and `mp4` for
//! container muxing. Accepts BGRA frames, converts to I420, encodes, writes to a
//! seekable MP4 file on finalize.

use crate::capture::{CaptureSink, Frame};
use crate::types::{CaptureQuality, VideoMetadata};
use std::fs::File;
use std::path::PathBuf;

/// Owns the openh264 encoder + mp4 writer for a single session.
/// The encoder is created once on `new()` and reused across frames — H.264
/// needs persistent state (SPS/PPS, reference frames).
pub struct Mp4EncoderSink {
    output_path: PathBuf,
    width: u32,
    height: u32,
    fps: u32,
    quality: CaptureQuality,
    has_audio: bool,
    start_ms: i64,
    last_frame_ms: i64,
    encoder: openh264::encoder::Encoder,
    encoded_frames: Vec<EncodedFrame>,
}

struct EncodedFrame {
    data: Vec<u8>,
    is_keyframe: bool,
    pts_ms: i64,
}

impl Mp4EncoderSink {
    pub fn new(
        output_path: PathBuf,
        width: u32,
        height: u32,
        fps: u32,
        quality: CaptureQuality,
        has_audio: bool,
        start_ms: i64,
    ) -> Result<Self, String> {
        use openh264::encoder::{Encoder, EncoderConfig};
        let cfg = EncoderConfig::new(width, height)
            .constant_sps(true)
            .max_frame_rate(fps as f32);
        let encoder = Encoder::with_config(cfg).map_err(|e| e.to_string())?;
        let _ = quality; // CRF mapping used by future platform-native encoder; openh264 tuning deferred.
        Ok(Self {
            output_path,
            width,
            height,
            fps,
            quality,
            has_audio,
            start_ms,
            last_frame_ms: start_ms,
            encoder,
            encoded_frames: Vec::new(),
        })
    }

    fn encode_frame(&mut self, frame: &Frame) -> Result<(), String> {
        use openh264::formats::YUVBuffer;

        let yuv = bgra_to_i420(&frame.data, self.width as usize, self.height as usize);
        let yuv_buf = YUVBuffer::with_rgb(self.width as usize, self.height as usize, &yuv);
        let bs = self.encoder.encode(&yuv_buf).map_err(|e| e.to_string())?;
        for i in 0..bs.num_layers() {
            let layer = bs.layer(i).ok_or("missing layer")?;
            for j in 0..layer.nal_count() {
                let nal = layer.nal_unit(j).ok_or("missing nal")?;
                self.encoded_frames.push(EncodedFrame {
                    data: nal.to_vec(),
                    is_keyframe: j == 0,
                    pts_ms: frame.timestamp_ms - self.start_ms,
                });
            }
        }
        self.last_frame_ms = frame.timestamp_ms;
        Ok(())
    }
}

impl CaptureSink for Mp4EncoderSink {
    fn on_frame(&mut self, frame: &Frame) -> Result<(), String> {
        self.encode_frame(frame)
    }

    fn finalize(self: Box<Self>) -> Result<VideoMetadata, String> {
        use mp4::{Mp4Config, Mp4Writer, TrackConfig, MediaType, AvcConfig, MediaConfig};

        let duration_ms = self.last_frame_ms - self.start_ms;
        let file = File::create(&self.output_path).map_err(|e| e.to_string())?;
        let cfg = Mp4Config {
            major_brand: b"mp42".into(),
            minor_version: 0,
            compatible_brands: vec![b"mp42".into(), b"isom".into()],
            timescale: 1000,
        };
        let mut writer = Mp4Writer::write_start(file, &cfg).map_err(|e| e.to_string())?;
        let track = TrackConfig {
            track_type: MediaType::H264,
            timescale: 1000,
            language: String::from("und"),
            media_conf: MediaConfig::AvcConfig(AvcConfig {
                width: self.width as u16,
                height: self.height as u16,
                seq_param_set: Vec::new(),
                pic_param_set: Vec::new(),
            }),
        };
        writer.add_track(&track).map_err(|e| e.to_string())?;

        for (idx, ef) in self.encoded_frames.iter().enumerate() {
            let sample = mp4::Mp4Sample {
                start_time: ef.pts_ms as u64,
                duration: (1000 / self.fps) as u32,
                rendering_offset: 0,
                is_sync: ef.is_keyframe,
                bytes: ef.data.clone().into(),
            };
            writer.write_sample(1, &sample).map_err(|e| e.to_string())?;
            let _ = idx;
        }
        writer.write_end().map_err(|e| e.to_string())?;

        Ok(VideoMetadata {
            path: self.output_path.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default(),
            start_ms: self.start_ms,
            duration_ms,
            width: self.width,
            height: self.height,
            fps: self.fps,
            has_audio: self.has_audio,
        })
    }
}

/// BGRA → I420 planar conversion. Standard BT.601 coefficients.
fn bgra_to_i420(bgra: &[u8], width: usize, height: usize) -> Vec<u8> {
    let y_size = width * height;
    let uv_size = y_size / 4;
    let mut out = vec![0u8; y_size + uv_size * 2];
    for y in 0..height {
        for x in 0..width {
            let i = (y * width + x) * 4;
            let (b, g, r) = (bgra[i] as f32, bgra[i + 1] as f32, bgra[i + 2] as f32);
            let yv = (0.257 * r + 0.504 * g + 0.098 * b + 16.0).clamp(0.0, 255.0) as u8;
            out[y * width + x] = yv;
            if y % 2 == 0 && x % 2 == 0 {
                let ui = y_size + (y / 2) * (width / 2) + x / 2;
                let vi = ui + uv_size;
                let u = (-0.148 * r - 0.291 * g + 0.439 * b + 128.0).clamp(0.0, 255.0) as u8;
                let v = (0.439 * r - 0.368 * g - 0.071 * b + 128.0).clamp(0.0, 255.0) as u8;
                out[ui] = u;
                out[vi] = v;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn synthetic_frame(width: u32, height: u32, ts: i64) -> Frame {
        Frame { width, height, data: vec![128; (width * height * 4) as usize], timestamp_ms: ts }
    }

    #[test]
    fn bgra_to_i420_produces_correct_plane_sizes() {
        let out = bgra_to_i420(&vec![128u8; 4 * 4 * 4], 4, 4);
        assert_eq!(out.len(), 4 * 4 + 4);
    }

    #[test]
    fn encoder_finalizes_produces_mp4() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("out.mp4");
        let mut sink = Box::new(
            Mp4EncoderSink::new(path.clone(), 320, 240, 30, CaptureQuality::Med, false, 1000).unwrap(),
        );
        for i in 0..10 {
            sink.on_frame(&synthetic_frame(320, 240, 1000 + i * 33)).unwrap();
        }
        let meta = sink.finalize().unwrap();
        assert!(path.exists());
        assert!(path.metadata().unwrap().len() > 0);
        assert_eq!(meta.width, 320);
        assert_eq!(meta.height, 240);
        assert_eq!(meta.fps, 30);
    }
}
```

- [ ] **Step 2: Add `tempfile` dev-dependency**

In `src-tauri/Cargo.toml`, add at the bottom (before the `[target.'cfg(target_os = "macos")']` block):

```toml
[dev-dependencies]
tempfile = "3"
```

- [ ] **Step 3: Wire encoder module into `src-tauri/src/lib.rs`**

Add near top:
```rust
mod encoder;
```

- [ ] **Step 4: Run tests**

Run: `cd src-tauri && cargo test encoder`
Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/encoder.rs src-tauri/src/lib.rs src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "feat(capture): add Mp4EncoderSink using openh264 + mp4 crates"
```

---

### Task 2.4: ScreenCaptureSession wraps scap

**Files:**
- Modify: `src-tauri/src/capture.rs`

- [ ] **Step 1: Append `ScreenCaptureSession` to `src-tauri/src/capture.rs`**

Add below the `FakeSink` section (still inside the file):

```rust
use crate::types::CaptureSettings;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::JoinHandle;
use chrono::Utc;

/// Configuration for starting a capture session. Built from AppSettings at runtime.
pub struct CaptureConfig {
    pub output_path: PathBuf,
    pub settings: CaptureSettings,
}

/// A live capture session. Start spawns a scap thread; stop signals it to finish
/// and finalizes the sink into a VideoMetadata.
pub struct ScreenCaptureSession {
    running: Arc<AtomicBool>,
    handle: Option<JoinHandle<Result<VideoMetadata, String>>>,
    start_ms: i64,
}

impl ScreenCaptureSession {
    pub fn start(config: CaptureConfig) -> Result<Self, String> {
        use scap::capturer::{Capturer, Options};
        use scap::frame::{Frame as ScapFrame, FrameType};

        if !scap::is_supported() {
            return Err("Screen capture is not supported on this platform".to_string());
        }
        if !scap::has_permission() {
            return Err("permission-denied".to_string());
        }

        let start_ms = Utc::now().timestamp_millis();
        let running = Arc::new(AtomicBool::new(true));
        let running_thread = Arc::clone(&running);
        let settings = config.settings;
        let output_path = config.output_path.clone();

        let handle = std::thread::spawn(move || -> Result<VideoMetadata, String> {
            let opts = Options {
                fps: settings.fps,
                show_cursor: true,
                show_highlight: false,
                target: None,
                crop_area: None,
                output_type: FrameType::BGRAFrame,
                output_resolution: scap::capturer::Resolution::Captured,
                ..Default::default()
            };
            let mut capturer = Capturer::build(opts).map_err(|e| format!("{:?}", e))?;
            capturer.start_capture();

            // Grab first frame to learn actual dimensions.
            let first = capturer.get_next_frame().map_err(|e| format!("{:?}", e))?;
            let (width, height, first_data, first_ts) = match first {
                ScapFrame::BGRA(f) => (f.width as u32, f.height as u32, f.data, Utc::now().timestamp_millis()),
                _ => return Err("Unexpected frame format".to_string()),
            };

            let mut sink: Box<dyn CaptureSink> = Box::new(
                crate::encoder::Mp4EncoderSink::new(
                    output_path.clone(),
                    width,
                    height,
                    settings.fps,
                    settings.quality,
                    settings.audio,
                    start_ms,
                )?,
            );
            sink.on_frame(&Frame { width, height, data: first_data, timestamp_ms: first_ts })?;

            while running_thread.load(Ordering::Relaxed) {
                match capturer.get_next_frame() {
                    Ok(ScapFrame::BGRA(f)) => {
                        let ts = Utc::now().timestamp_millis();
                        if let Err(e) = sink.on_frame(&Frame { width: f.width as u32, height: f.height as u32, data: f.data, timestamp_ms: ts }) {
                            eprintln!("capture: sink error {e}");
                            break;
                        }
                    },
                    Ok(_) => continue,
                    Err(e) => {
                        eprintln!("capture: frame error {:?}", e);
                        break;
                    },
                }
            }

            capturer.stop_capture();
            sink.finalize()
        });

        Ok(Self { running, handle: Some(handle), start_ms })
    }

    pub fn stop(mut self) -> Result<VideoMetadata, String> {
        self.running.store(false, Ordering::Relaxed);
        let handle = self.handle.take().ok_or("already stopped")?;
        handle.join().map_err(|_| "capture thread panicked".to_string())?
    }

    pub fn start_ms(&self) -> i64 {
        self.start_ms
    }
}
```

- [ ] **Step 2: Verify build**

Run: `cd src-tauri && cargo check`
Expected: compiles.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/capture.rs
git commit -m "feat(capture): add ScreenCaptureSession wrapping scap"
```

---

### Task 2.5: Permission check module (macOS)

**Files:**
- Create: `src-tauri/src/permissions.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Create `src-tauri/src/permissions.rs`**

```rust
//! Permission checks. Today we only need macOS Screen Recording (TCC
//! `kTCCServiceScreenCapture`). Windows needs no permission for WGC.

#[cfg(target_os = "macos")]
pub fn has_screen_recording_permission() -> bool {
    scap::has_permission()
}

#[cfg(not(target_os = "macos"))]
pub fn has_screen_recording_permission() -> bool {
    true
}

#[cfg(target_os = "macos")]
pub fn request_screen_recording_permission() {
    // scap::request_permission triggers the OS prompt. A user must then restart.
    scap::request_permission();
}

#[cfg(not(target_os = "macos"))]
pub fn request_screen_recording_permission() {}

#[tauri::command]
pub fn check_screen_recording_permission() -> bool {
    has_screen_recording_permission()
}

#[tauri::command]
pub fn request_screen_recording() {
    request_screen_recording_permission();
}
```

- [ ] **Step 2: Wire into `src-tauri/src/lib.rs`**

Add near top:
```rust
mod permissions;
```

Add to `invoke_handler![]`:
```rust
permissions::check_screen_recording_permission,
permissions::request_screen_recording,
```

- [ ] **Step 3: Verify build**

Run: `cd src-tauri && cargo check`
Expected: compiles.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/permissions.rs src-tauri/src/lib.rs
git commit -m "feat(permissions): add screen recording permission check"
```

---

### Task 2.6: Integrate capture into start/stop recording

**Files:**
- Modify: `src-tauri/src/types.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Extend `RecordingState` in `src-tauri/src/types.rs`**

Replace the `RecordingState` struct and `Default` impl with:

```rust
use crate::capture::ScreenCaptureSession;

pub struct RecordingState {
    pub is_recording: Arc<Mutex<bool>>,
    pub current_events: Arc<Mutex<Vec<InputEvent>>>,
    pub last_mouse_position: Arc<Mutex<Option<(f64, f64)>>>,
    pub pressed_modifiers: Arc<Mutex<HashSet<Key>>>,
    pub pressed_buttons: Arc<Mutex<HashSet<Button>>>,
    pub is_playing: Arc<Mutex<bool>>,
    pub playback_position: Arc<Mutex<Option<usize>>>,
    pub loop_count: Arc<Mutex<usize>>,
    pub current_id: Arc<Mutex<Option<String>>>,
    pub capture_session: Arc<Mutex<Option<ScreenCaptureSession>>>,
    pub last_video_meta: Arc<Mutex<Option<VideoMetadata>>>,
}

impl Default for RecordingState {
    fn default() -> Self {
        Self {
            is_recording: Arc::new(Mutex::new(false)),
            current_events: Arc::new(Mutex::new(Vec::new())),
            last_mouse_position: Arc::new(Mutex::new(None)),
            pressed_modifiers: Arc::new(Mutex::new(HashSet::new())),
            pressed_buttons: Arc::new(Mutex::new(HashSet::new())),
            is_playing: Arc::new(Mutex::new(false)),
            playback_position: Arc::new(Mutex::new(None)),
            loop_count: Arc::new(Mutex::new(0)),
            current_id: Arc::new(Mutex::new(None)),
            capture_session: Arc::new(Mutex::new(None)),
            last_video_meta: Arc::new(Mutex::new(None)),
        }
    }
}
```

- [ ] **Step 2: Update `start_recording` in `src-tauri/src/lib.rs`**

Replace the entire `start_recording` function (lib.rs:28-49) with:

```rust
#[tauri::command]
fn start_recording(app: AppHandle, state: State<RecordingState>) -> Result<String, String> {
    let mut is_recording = state.is_recording.lock().map_err(|e| e.to_string())?;
    if *is_recording {
        return Err("Already recording".to_string());
    }

    // Generate recording id up front so the video filename can use it.
    let id = chrono::Utc::now().timestamp_millis().to_string();

    // Build capture config from settings.
    let settings = crate::settings::load(&app);
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let videos_dir = app_data_dir.join("videos");
    std::fs::create_dir_all(&videos_dir).map_err(|e| e.to_string())?;
    let output_path = videos_dir.join(format!("{}.mp4", id));

    // Start capture (may fail on permission denied — surface the error).
    let session_result = crate::capture::ScreenCaptureSession::start(crate::capture::CaptureConfig {
        output_path,
        settings: settings.capture,
    });
    match session_result {
        Ok(session) => {
            *state.capture_session.lock().map_err(|e| e.to_string())? = Some(session);
        },
        Err(e) if e == "permission-denied" => {
            let _ = app.emit("permission-needed", "screen-recording");
            return Err(e);
        },
        Err(e) => {
            // Capture failed for another reason; we still allow event-only recording.
            let _ = app.emit("capture-failed", e.clone());
            eprintln!("capture failed to start: {e}");
        },
    }

    *is_recording = true;
    drop(is_recording);

    *state.current_events.lock().map_err(|e| e.to_string())? = Vec::new();
    *state.pressed_modifiers.lock().map_err(|e| e.to_string())? = std::collections::HashSet::new();
    *state.pressed_buttons.lock().map_err(|e| e.to_string())? = std::collections::HashSet::new();
    *state.current_id.lock().map_err(|e| e.to_string())? = Some(id.clone());
    *state.last_video_meta.lock().map_err(|e| e.to_string())? = None;

    Ok(id)
}
```

- [ ] **Step 3: Update `stop_recording` in `src-tauri/src/lib.rs`**

Replace the `stop_recording` function (lib.rs:51-67) with:

```rust
#[derive(serde::Serialize)]
struct StopResult {
    id: String,
    events: Vec<InputEvent>,
    video: Option<VideoMetadata>,
}

#[tauri::command]
fn stop_recording(state: State<RecordingState>) -> Result<StopResult, String> {
    let mut is_recording = state.is_recording.lock().map_err(|e| e.to_string())?;
    if !*is_recording {
        return Err("Not recording".to_string());
    }
    *is_recording = false;
    drop(is_recording);

    let events = state.current_events.lock().map_err(|e| e.to_string())?.clone();
    let id = state.current_id.lock().map_err(|e| e.to_string())?
        .clone()
        .ok_or("No recording id set")?;

    // Stop + finalize capture if one was started.
    let video = {
        let session = state.capture_session.lock().map_err(|e| e.to_string())?.take();
        match session {
            Some(s) => match s.stop() {
                Ok(meta) => Some(meta),
                Err(e) => {
                    eprintln!("capture finalize failed: {e}");
                    None
                },
            },
            None => None,
        }
    };

    if let Some(ref v) = video {
        *state.last_video_meta.lock().map_err(|e| e.to_string())? = Some(v.clone());
    }

    Ok(StopResult { id, events, video })
}
```

- [ ] **Step 4: Update `save_recording` to accept `video` + use passed `id`**

Replace `save_recording` (lib.rs:69-105) with:

```rust
#[tauri::command]
fn save_recording(
    app_handle: AppHandle,
    id: String,
    name: String,
    events: Vec<InputEvent>,
    video: Option<VideoMetadata>,
) -> Result<Recording, String> {
    let app_data_dir = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&app_data_dir).map_err(|e| e.to_string())?;
    let recordings_file = app_data_dir.join("recordings.json");

    let mut recordings: Vec<Recording> = if recordings_file.exists() {
        let content = std::fs::read_to_string(&recordings_file).map_err(|e| e.to_string())?;
        serde_json::from_str(&content).unwrap_or_default()
    } else {
        Vec::new()
    };

    let recording = Recording {
        id: id.clone(),
        name,
        events,
        created_at: chrono::Utc::now().timestamp_millis(),
        playback_speed: 1.0,
        video,
    };
    recordings.push(recording.clone());
    let content = serde_json::to_string_pretty(&recordings).map_err(|e| e.to_string())?;
    std::fs::write(&recordings_file, content).map_err(|e| e.to_string())?;
    Ok(recording)
}
```

- [ ] **Step 5: Update `useRecorder` to pass the new shape**

Replace `src/hooks/useRecorder.ts`:

```ts
import { useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { InputEvent, RecordingStatus, VideoMetadata } from "@/types";

interface StopResult {
  id: string;
  events: InputEvent[];
  video: VideoMetadata | null;
}

export const useRecorder = () => {
  const [status, setStatus] = useState<RecordingStatus>(RecordingStatus.Idle);
  const [currentEvents, setCurrentEvents] = useState<InputEvent[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);

  const startRecording = useCallback(async () => {
    const id = await invoke<string>("start_recording");
    setCurrentId(id);
    setStatus(RecordingStatus.Recording);
    setCurrentEvents([]);
  }, []);

  const stopRecording = useCallback(async () => {
    const result = await invoke<StopResult>("stop_recording");
    setStatus(RecordingStatus.Stopped);
    return result;
  }, []);

  const addEvent = useCallback((event: InputEvent) => {
    setCurrentEvents((prev) => [...prev, event]);
  }, []);

  const clearEvents = useCallback(() => {
    setCurrentEvents([]);
    setStatus(RecordingStatus.Idle);
    setCurrentId(null);
  }, []);

  return {
    status,
    currentEvents,
    currentId,
    isRecording: status === RecordingStatus.Recording,
    startRecording,
    stopRecording,
    addEvent,
    clearEvents,
  } as const;
};
```

- [ ] **Step 6: Update `App.tsx` stop handler to pass new args**

In `src/App.tsx`, replace `handleStopRecording` (lines 59-74) with:

```tsx
const handleStopRecording = useCallback(async () => {
  try {
    const result = await recorder.stopRecording();
    if (result.events.length > 0 || result.video) {
      const newRecording = await recordingsManager.saveRecording(
        result.id,
        "Untitled",
        result.events,
        result.video ?? undefined,
      );
      recorder.clearEvents();
      recordingsManager.setSelectedRecording(newRecording);
      setIsExpanded(true);
    }
  } catch (error) {
    console.error("Failed to stop recording:", error);
  }
}, [recorder, recordingsManager]);
```

- [ ] **Step 7: Update `useRecordings.saveRecording` signature**

Replace `src/hooks/useRecordings.ts` with:

```ts
import { useState, useCallback, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Recording, InputEvent, VideoMetadata } from "@/types";

export const useRecordings = () => {
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [selectedRecording, setSelectedRecording] = useState<Recording | null>(null);

  const loadRecordings = useCallback(async () => {
    const result = await invoke<Recording[]>("load_recordings");
    setRecordings(result.sort((a, b) => b.created_at - a.created_at));
  }, []);

  const saveRecording = useCallback(
    async (id: string, name: string, events: InputEvent[], video?: VideoMetadata): Promise<Recording> => {
      const recording = await invoke<Recording>("save_recording", {
        id,
        name,
        events,
        video: video ?? null,
      });
      await loadRecordings();
      return recording;
    },
    [loadRecordings],
  );

  const deleteRecording = useCallback(async (id: string) => {
    await invoke("delete_recording", { id });
    await loadRecordings();
    setSelectedRecording((current) => (current?.id === id ? null : current));
  }, [loadRecordings]);

  const updateRecordingName = useCallback(async (id: string, name: string): Promise<Recording> => {
    const recording = await invoke<Recording>("update_recording_name", { id, name });
    await loadRecordings();
    setSelectedRecording((current) => (current?.id === id ? recording : current));
    return recording;
  }, [loadRecordings]);

  const updateRecordingSpeed = useCallback(async (id: string, speed: number): Promise<Recording> => {
    const recording = await invoke<Recording>("update_recording_speed", { id, speed });
    await loadRecordings();
    setSelectedRecording((current) => (current?.id === id ? recording : current));
    return recording;
  }, [loadRecordings]);

  useEffect(() => { loadRecordings(); }, [loadRecordings]);

  return {
    recordings,
    selectedRecording,
    setSelectedRecording,
    saveRecording,
    deleteRecording,
    updateRecordingName,
    updateRecordingSpeed,
    loadRecordings,
  } as const;
};
```

- [ ] **Step 8: Verify build + run**

Run: `cd src-tauri && cargo check`
Run: `pnpm build`
Expected: both succeed.

- [ ] **Step 9: Commit**

```bash
git add src-tauri/src/types.rs src-tauri/src/lib.rs src/hooks/useRecorder.ts src/hooks/useRecordings.ts src/App.tsx
git commit -m "feat(capture): integrate screen capture into recording lifecycle"
```

---

### Task 2.7: Orphan sweep + cleanup on delete

**Files:**
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add `sweep_orphan_videos` helper and call it at startup**

In `src-tauri/src/lib.rs` near the other helpers, add:

```rust
fn sweep_orphan_videos(app: &AppHandle) {
    let Ok(dir) = app.path().app_data_dir() else { return };
    let videos_dir = dir.join("videos");
    if !videos_dir.exists() { return }
    let recordings_file = dir.join("recordings.json");
    let known_ids: std::collections::HashSet<String> = if recordings_file.exists() {
        let content = std::fs::read_to_string(&recordings_file).unwrap_or_default();
        let list: Vec<Recording> = serde_json::from_str(&content).unwrap_or_default();
        list.into_iter().map(|r| r.id).collect()
    } else {
        Default::default()
    };
    if let Ok(entries) = std::fs::read_dir(&videos_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("mp4") { continue }
            let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else { continue };
            if !known_ids.contains(stem) {
                let _ = std::fs::remove_file(&path);
            }
        }
    }
}
```

Inside `run()` setup closure, after the nspanel init, add:
```rust
sweep_orphan_videos(app.app_handle());
```

- [ ] **Step 2: Update `delete_recording` to also remove the video**

Replace the `delete_recording` function with:

```rust
#[tauri::command]
fn delete_recording(app_handle: AppHandle, id: String) -> Result<(), String> {
    let app_data_dir = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    let recordings_file = app_data_dir.join("recordings.json");
    if !recordings_file.exists() {
        return Err("No recordings found".to_string());
    }
    let content = std::fs::read_to_string(&recordings_file).map_err(|e| e.to_string())?;
    let mut recordings: Vec<Recording> = serde_json::from_str(&content).unwrap_or_default();
    recordings.retain(|r| r.id != id);
    let content = serde_json::to_string_pretty(&recordings).map_err(|e| e.to_string())?;
    std::fs::write(&recordings_file, content).map_err(|e| e.to_string())?;

    // Best-effort video cleanup.
    let video_path = app_data_dir.join("videos").join(format!("{}.mp4", id));
    let _ = std::fs::remove_file(&video_path);
    Ok(())
}
```

- [ ] **Step 3: Verify build**

Run: `cd src-tauri && cargo check`
Expected: compiles.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(capture): sweep orphan MP4s at startup and on delete"
```

---

## Phase 3 — Playback window plumbing

### Task 3.1: Multi-entry Vite + playback window config

**Files:**
- Modify: `vite.config.ts`
- Create: `playback.html`
- Create: `src/windows/playback.tsx`
- Modify: `src-tauri/tauri.conf.json`
- Modify: `src-tauri/capabilities/default.json`

- [ ] **Step 1: Update `vite.config.ts` for multi-entry**

Replace the existing config with:

```ts
import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "path";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, "index.html"),
        playback: path.resolve(__dirname, "playback.html"),
      },
    },
  },
}));
```

- [ ] **Step 2: Create `playback.html` at project root**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Macroni — Playback</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/windows/playback.tsx"></script>
  </body>
</html>
```

- [ ] **Step 3: Create stub playback entry at `src/windows/playback.tsx`**

```tsx
import React from "react";
import ReactDOM from "react-dom/client";
import "@/index.css";
import { ThemeProvider } from "@/components/theme-provider";

const Playback = () => {
  const params = new URLSearchParams(window.location.search);
  const recordingId = params.get("id") ?? "";
  return (
    <ThemeProvider>
      <div className="w-screen h-screen flex items-center justify-center bg-background text-foreground">
        <p>Playback window — recording id: {recordingId}</p>
      </div>
    </ThemeProvider>
  );
};

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Playback />
  </React.StrictMode>,
);
```

- [ ] **Step 4: Register the playback window in `src-tauri/tauri.conf.json`**

Replace the `"windows"` array with:

```json
"windows": [
  {
    "label": "main",
    "title": "Macroni",
    "width": 700,
    "height": 50,
    "minWidth": 300,
    "minHeight": 50,
    "decorations": false,
    "transparent": true,
    "alwaysOnTop": true,
    "visibleOnAllWorkspaces": true,
    "resizable": false,
    "contentProtected": true,
    "acceptFirstMouse": true
  },
  {
    "label": "playback",
    "title": "Playback",
    "url": "playback.html",
    "width": 1200,
    "height": 750,
    "minWidth": 800,
    "minHeight": 500,
    "visible": false,
    "resizable": true,
    "decorations": true
  }
]
```

- [ ] **Step 5: Update capabilities to include the playback window**

Replace `src-tauri/capabilities/default.json` with:

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Default window capabilities",
  "windows": ["main", "playback"],
  "permissions": [
    "core:default",
    "core:window:allow-start-dragging",
    "core:window:allow-show",
    "core:window:allow-set-title",
    "global-shortcut:default",
    "opener:default"
  ]
}
```

- [ ] **Step 6: Run app and verify playback window opens (invisibly by default; we'll open it via command next task)**

Run: `pnpm tauri dev`
Expected: main window still shows; no playback window visible yet (that's correct — `visible: false`).

- [ ] **Step 7: Commit**

```bash
git add vite.config.ts playback.html src/windows/playback.tsx src-tauri/tauri.conf.json src-tauri/capabilities/default.json
git commit -m "feat(playback): add playback window multi-entry scaffolding"
```

---

### Task 3.2: `open_playback_window` command + wire from list

**Files:**
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/components/RecordingsList.tsx`
- Modify: `src/App.tsx`

- [ ] **Step 1: Add `open_playback_window` command in `src-tauri/src/lib.rs`**

Add near the other commands:

```rust
#[tauri::command]
fn open_playback_window(app: AppHandle, recording_id: String) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("playback") {
        window.eval(&format!("window.location.href = 'playback.html?id={}'", recording_id))
            .map_err(|e| e.to_string())?;
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }
    Err("playback window not configured".to_string())
}
```

Add to `invoke_handler![]`: `open_playback_window,`.

- [ ] **Step 2: Add a video icon button in `RecordingsList`**

In `src/components/RecordingsList.tsx`, import `Play`:

```tsx
import { Trash2, Play } from "lucide-react";
```

Add a new prop `onOpenPlayback: (id: string) => void` to `RecordingsListProps`, and render a Play button next to the trash icon:

```tsx
<Button
  variant="ghost"
  size="icon"
  className="h-8 w-8"
  onClick={(e) => { e.stopPropagation(); onOpenPlayback(recording.id); }}
>
  <Play className="h-3.5 w-3.5" />
</Button>
```

- [ ] **Step 3: Wire the handler in `App.tsx`**

Pass a new `onOpenPlayback` prop:

```tsx
onOpenPlayback={(id: string) => invoke("open_playback_window", { recordingId: id })}
```

- [ ] **Step 4: Run app and confirm the Play button opens the playback window**

Run: `pnpm tauri dev`
Create a quick recording, click the Play icon in the Recordings tab → the playback window opens and shows the recording id.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/lib.rs src/components/RecordingsList.tsx src/App.tsx
git commit -m "feat(playback): add open_playback_window command and list button"
```

---

## Phase 4 — Playback UI

### Task 4.1: `usePlaybackSync` hook (pure, tested)

**Files:**
- Create: `src/hooks/usePlaybackSync.ts`
- Create: `src/hooks/__tests__/usePlaybackSync.test.ts`

- [ ] **Step 1: Write failing test for sync primitives**

```ts
// src/hooks/__tests__/usePlaybackSync.test.ts
import { describe, it, expect } from "vitest";
import { findActiveEventIndex } from "../usePlaybackSync";
import type { InputEvent } from "@/types";
import { InputEventType } from "@/types";

const mk = (t: number): InputEvent => ({
  type: InputEventType.KeyPress,
  key: "a",
  timestamp: t,
});

describe("findActiveEventIndex", () => {
  const events = [mk(100), mk(200), mk(350), mk(500)];

  it("returns 0 before first event", () => {
    expect(findActiveEventIndex(events, 50)).toBe(0);
  });

  it("returns exact match", () => {
    expect(findActiveEventIndex(events, 200)).toBe(1);
  });

  it("returns nearest preceding event for times between events", () => {
    expect(findActiveEventIndex(events, 300)).toBe(1);
    expect(findActiveEventIndex(events, 349)).toBe(1);
    expect(findActiveEventIndex(events, 350)).toBe(2);
  });

  it("returns last event for times past end", () => {
    expect(findActiveEventIndex(events, 9999)).toBe(3);
  });

  it("returns -1 for empty list", () => {
    expect(findActiveEventIndex([], 100)).toBe(-1);
  });
});
```

- [ ] **Step 2: Run test to verify fail**

Run: `pnpm test usePlaybackSync`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/hooks/usePlaybackSync.ts`**

```ts
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
  currentMs: number;      // absolute UTC ms
  activeIndex: number;
  videoTimeMs: number;    // video.currentTime * 1000, for <video> seek
}

interface UsePlaybackSyncArgs {
  events: InputEvent[];
  video: VideoMetadata | null;
}

export function usePlaybackSync({ events, video }: UsePlaybackSyncArgs) {
  const startMs = video?.start_ms ?? (events[0]?.timestamp ?? 0);
  const [state, setState] = useState<SyncState>({ currentMs: startMs, activeIndex: -1, videoTimeMs: 0 });
  const userScrolledAt = useRef<number>(0);

  // Called by VideoPlayer on timeupdate.
  const onVideoTime = useCallback((videoSeconds: number) => {
    const videoTimeMs = videoSeconds * 1000;
    const absoluteMs = startMs + videoTimeMs;
    setState({
      currentMs: absoluteMs,
      activeIndex: findActiveEventIndex(events, absoluteMs),
      videoTimeMs,
    });
  }, [events, startMs]);

  // Called when user clicks an event → seek video.
  const seekToEvent = useCallback((index: number) => {
    if (!events[index]) return;
    const absoluteMs = events[index].timestamp;
    const videoTimeMs = Math.max(0, absoluteMs - startMs);
    setState({ currentMs: absoluteMs, activeIndex: index, videoTimeMs });
  }, [events, startMs]);

  // Called by the scrubber.
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

  // Initialize activeIndex on first load.
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
```

- [ ] **Step 4: Run tests**

Run: `pnpm test usePlaybackSync`
Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/usePlaybackSync.ts src/hooks/__tests__/usePlaybackSync.test.ts
git commit -m "feat(playback): add usePlaybackSync with binary-search active event"
```

---

### Task 4.2: `useVideoAssetUrl` hook + asset protocol config

**Files:**
- Create: `src/hooks/useVideoAssetUrl.ts`
- Modify: `src-tauri/capabilities/default.json`
- Modify: `src-tauri/tauri.conf.json`

- [ ] **Step 1: Add asset protocol scope for `videos/**`**

In `src-tauri/tauri.conf.json`, under `"app"`, add/merge:

```json
"security": {
  "csp": null,
  "assetProtocol": {
    "enable": true,
    "scope": ["$APPDATA/videos/**"]
  }
}
```

- [ ] **Step 2: Create `src/hooks/useVideoAssetUrl.ts`**

```ts
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { VideoMetadata } from "@/types";

/**
 * Resolve a VideoMetadata (whose `path` is relative to app data dir) into a
 * URL the `<video>` element can stream from via the Tauri asset protocol.
 */
export function useVideoAssetUrl(video: VideoMetadata | null | undefined) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!video) { setUrl(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const appDataDir = await invoke<string>("get_app_data_dir");
        if (cancelled) return;
        const full = `${appDataDir}/videos/${video.path}`;
        setUrl(convertFileSrc(full));
      } catch (e) {
        setError(String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [video]);

  return { url, error } as const;
}
```

- [ ] **Step 3: Add `get_app_data_dir` Tauri command**

In `src-tauri/src/lib.rs`, add:

```rust
#[tauri::command]
fn get_app_data_dir(app: AppHandle) -> Result<String, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().into_owned())
}
```

Add to `invoke_handler![]`: `get_app_data_dir,`.

- [ ] **Step 4: Verify build**

Run: `cd src-tauri && cargo check`
Run: `pnpm build`
Expected: both succeed.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/lib.rs src-tauri/tauri.conf.json src/hooks/useVideoAssetUrl.ts
git commit -m "feat(playback): add useVideoAssetUrl + asset protocol scope"
```

---

### Task 4.3: `VideoPlayer` component

**Files:**
- Create: `src/components/playback/VideoPlayer.tsx`

- [ ] **Step 1: Implement `src/components/playback/VideoPlayer.tsx`**

```tsx
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
      play: async () => { await videoRef.current?.play(); },
      pause: () => { videoRef.current?.pause(); },
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
```

- [ ] **Step 2: Commit**

```bash
git add src/components/playback/VideoPlayer.tsx
git commit -m "feat(playback): add VideoPlayer component"
```

---

### Task 4.4: `EventTimeline` scrubber with event markers

**Files:**
- Create: `src/components/playback/EventTimeline.tsx`
- Create: `src/components/playback/__tests__/EventTimeline.test.tsx`

- [ ] **Step 1: Write failing test for marker positioning**

```tsx
// src/components/playback/__tests__/EventTimeline.test.tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { EventTimeline } from "../EventTimeline";
import { InputEventType } from "@/types";

describe("EventTimeline", () => {
  it("renders a marker per non-MouseMove event", () => {
    const events = [
      { type: InputEventType.KeyPress, key: "a", timestamp: 1000 },
      { type: InputEventType.MouseMove, x: 0, y: 0, timestamp: 1100 },
      { type: InputEventType.ButtonPress, button: "Left", x: 0, y: 0, timestamp: 1500 },
    ];
    render(
      <EventTimeline
        events={events}
        startMs={1000}
        durationMs={1000}
        activeIndex={0}
        onSeek={() => {}}
      />,
    );
    const markers = screen.getAllByTestId(/^event-marker-/);
    expect(markers.length).toBe(2); // MouseMove filtered out
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test EventTimeline`
Expected: FAIL — component not found.

- [ ] **Step 3: Implement `src/components/playback/EventTimeline.tsx`**

```tsx
import { useRef, useCallback } from "react";
import { InputEvent, InputEventType } from "@/types";

interface Props {
  events: InputEvent[];
  startMs: number;
  durationMs: number;
  activeIndex: number;
  onSeek: (absoluteMs: number) => void;
}

const colorFor = (type: InputEventType): string => {
  switch (type) {
    case InputEventType.KeyPress:
    case InputEventType.KeyRelease:
    case InputEventType.KeyCombo:
      return "bg-blue-500";
    case InputEventType.ButtonPress:
    case InputEventType.ButtonRelease:
      return "bg-amber-500";
    default:
      return "bg-muted-foreground";
  }
};

export function EventTimeline({ events, startMs, durationMs, activeIndex, onSeek }: Props) {
  const trackRef = useRef<HTMLDivElement>(null);

  const handleTrackClick = useCallback((e: React.MouseEvent) => {
    if (!trackRef.current || durationMs <= 0) return;
    const rect = trackRef.current.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    onSeek(startMs + ratio * durationMs);
  }, [durationMs, startMs, onSeek]);

  const renderable = events.filter((e) => e.type !== InputEventType.MouseMove);

  return (
    <div className="relative w-full h-6" onClick={handleTrackClick}>
      <div ref={trackRef} className="absolute inset-0 bg-muted/30 rounded" />
      {renderable.map((event, i) => {
        const pct = durationMs > 0 ? ((event.timestamp - startMs) / durationMs) * 100 : 0;
        const realIndex = events.indexOf(event);
        const active = realIndex === activeIndex;
        return (
          <div
            key={i}
            data-testid={`event-marker-${i}`}
            title={event.type}
            style={{ left: `${pct}%` }}
            className={`absolute top-0 bottom-0 w-0.5 ${colorFor(event.type)} ${active ? "ring-2 ring-primary" : ""}`}
            onClick={(e) => {
              e.stopPropagation();
              onSeek(event.timestamp);
            }}
          />
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: Run test**

Run: `pnpm test EventTimeline`
Expected: 1 test passes.

- [ ] **Step 5: Commit**

```bash
git add src/components/playback/EventTimeline.tsx src/components/playback/__tests__/EventTimeline.test.tsx
git commit -m "feat(playback): add EventTimeline scrubber with event markers"
```

---

### Task 4.5: `SyncedEventList` component

**Files:**
- Create: `src/components/playback/SyncedEventList.tsx`

- [ ] **Step 1: Implement `src/components/playback/SyncedEventList.tsx`**

```tsx
import { useEffect, useRef } from "react";
import { InputEvent, InputEventType } from "@/types";

interface Props {
  events: InputEvent[];
  activeIndex: number;
  onClickEvent: (index: number) => void;
  onUserScroll: () => void;
  autoScrollEnabled: boolean;
}

const describe = (event: InputEvent): string => {
  switch (event.type) {
    case InputEventType.KeyPress: return `KeyPress ${event.key}`;
    case InputEventType.KeyRelease: return `KeyRelease ${event.key}`;
    case InputEventType.KeyCombo: return `${event.modifiers.join("+")}+${event.char}`;
    case InputEventType.ButtonPress: return `ButtonPress ${event.button} (${event.x.toFixed(0)}, ${event.y.toFixed(0)})`;
    case InputEventType.ButtonRelease: return `ButtonRelease ${event.button}`;
    case InputEventType.MouseMove: return `MouseMove (${event.x.toFixed(0)}, ${event.y.toFixed(0)})`;
  }
};

export function SyncedEventList({ events, activeIndex, onClickEvent, onUserScroll, autoScrollEnabled }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    if (!autoScrollEnabled) return;
    const el = itemRefs.current[activeIndex];
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [activeIndex, autoScrollEnabled]);

  return (
    <div
      ref={containerRef}
      className="h-full overflow-y-auto border rounded-lg bg-muted/20 p-2 font-mono text-xs"
      onScroll={onUserScroll}
      onWheel={onUserScroll}
    >
      {events.map((e, i) => (
        <div
          key={i}
          ref={(el) => { itemRefs.current[i] = el; }}
          onClick={() => onClickEvent(i)}
          className={`px-2 py-1 rounded cursor-pointer ${i === activeIndex ? "bg-primary/20" : "hover:bg-muted/40"}`}
        >
          <span className="text-muted-foreground mr-2">{e.timestamp}</span>
          {describe(e)}
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/playback/SyncedEventList.tsx
git commit -m "feat(playback): add SyncedEventList with auto-scroll"
```

---

### Task 4.6: `PlaybackView` composition

**Files:**
- Create: `src/components/playback/PlaybackView.tsx`
- Modify: `src/windows/playback.tsx`

- [ ] **Step 1: Implement `src/components/playback/PlaybackView.tsx`**

```tsx
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
        if (!r) { setLoadError("Recording not found"); return; }
        setRecording(r);
      })
      .catch((e) => setLoadError(String(e)));
  }, [recordingId]);

  const events = recording?.events ?? [];
  const video = recording?.video ?? null;
  const sync = usePlaybackSync({ events, video });
  const { url: videoUrl, error: videoUrlError } = useVideoAssetUrl(video);

  // Seek video when user clicks an event in the list.
  useEffect(() => {
    videoRef.current?.seekSeconds(sync.videoTimeMs / 1000);
  }, [sync.videoTimeMs]);

  if (loadError) {
    return <div className="h-screen flex items-center justify-center text-destructive">{loadError}</div>;
  }
  if (!recording) {
    return <div className="h-screen flex items-center justify-center">Loading…</div>;
  }

  const videoMissing = !video || !videoUrl || !!videoUrlError;
  const durationMs = video?.duration_ms ?? (events.length > 0 ? events[events.length - 1].timestamp - sync.startMs : 0);

  return (
    <div className="h-screen flex flex-col bg-background text-foreground p-4 gap-3">
      <div className="flex-1 grid grid-cols-5 gap-3 min-h-0">
        <div className="col-span-3 min-h-0">
          {videoMissing ? (
            <div className="w-full h-full flex items-center justify-center border rounded-lg bg-muted/20">
              <p className="text-sm text-muted-foreground">Video file not found — event list only</p>
            </div>
          ) : (
            <VideoPlayer
              ref={videoRef}
              src={videoUrl!}
              onTimeUpdate={sync.onVideoTime}
              onError={() => { /* handled by videoMissing check */ }}
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
        {recording.name} — {events.length} events — {video ? `${(video.duration_ms / 1000).toFixed(1)}s` : "no video"}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Wire it into `src/windows/playback.tsx`**

Replace content with:

```tsx
import React from "react";
import ReactDOM from "react-dom/client";
import "@/index.css";
import { ThemeProvider } from "@/components/theme-provider";
import { PlaybackView } from "@/components/playback/PlaybackView";

const Playback = () => {
  const params = new URLSearchParams(window.location.search);
  const recordingId = params.get("id") ?? "";
  return (
    <ThemeProvider>
      <PlaybackView recordingId={recordingId} />
    </ThemeProvider>
  );
};

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Playback />
  </React.StrictMode>,
);
```

- [ ] **Step 3: Run app, create a recording, open playback**

Run: `pnpm tauri dev`
Manually: record ~5s, stop, click Play in the Recordings list. Playback window opens with video, event list, and scrubber. Verify:
- Clicking an event seeks the video.
- Scrubbing the video updates the event highlight.
- MouseMove events don't clutter the scrubber.

- [ ] **Step 4: Commit**

```bash
git add src/components/playback/PlaybackView.tsx src/windows/playback.tsx
git commit -m "feat(playback): compose PlaybackView with bidirectional sync"
```

---

## Phase 5 — Polish

### Task 5.1: Permission guide extension + toasts

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/components/SettingsTab.tsx`

- [ ] **Step 1: Add a `permission-needed` listener in `App.tsx`**

Inside the top-level `App` component, add an effect:

```tsx
useEffect(() => {
  const unlisten = listen<string>("permission-needed", (ev) => {
    if (ev.payload === "screen-recording") {
      alert("Macroni needs Screen Recording permission. Open System Settings → Privacy & Security → Screen Recording, enable Macroni, and restart the app.");
    }
  });
  const unlistenFail = listen<string>("capture-failed", (ev) => {
    console.error("Video capture failed:", ev.payload);
  });
  return () => {
    unlisten.then((fn) => fn());
    unlistenFail.then((fn) => fn());
  };
}, []);
```

- [ ] **Step 2: Verify manually on macOS**

Run: `pnpm tauri dev`
With Screen Recording permission disabled for the app, hit Start Recording → expect the alert.

- [ ] **Step 3: Commit**

```bash
git add src/App.tsx
git commit -m "feat(permissions): surface Screen Recording permission prompts"
```

---

### Task 5.2: CI test workflow

The existing `.github/workflows/release.yml` only runs on tag push for release builds. We need a separate test workflow that runs on every push/PR.

**Files:**
- Create: `.github/workflows/test.yml`

- [ ] **Step 1: Create `.github/workflows/test.yml`**

```yaml
name: Test

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    strategy:
      fail-fast: false
      matrix:
        os: [macos-latest, windows-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4

      - name: Setup pnpm
        uses: pnpm/action-setup@v4
        with:
          version: 10

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm

      - name: Install Rust stable
        uses: dtolnay/rust-toolchain@stable

      - name: Rust cache
        uses: swatinem/rust-cache@v2
        with:
          workspaces: src-tauri

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Run Rust tests
        run: cd src-tauri && cargo test

      - name: Run frontend tests
        run: pnpm test
```

- [ ] **Step 2: Verify the workflow passes locally first**

Run: `cd src-tauri && cargo test && cd .. && pnpm test`
Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/test.yml
git commit -m "ci: add test workflow running Rust + frontend tests on macOS + Windows"
```

---

### Task 5.3: Manual QA pass

**Files:** none — verification only.

- [ ] Record → stop → MP4 exists in `<app_data>/videos/<id>.mp4`.
- [ ] Click Play icon in Recordings list → playback window opens.
- [ ] Video plays with audio (macOS 14.2+).
- [ ] Click an event in the list → video seeks accurately (within ~100ms).
- [ ] Scrub video → active event in list highlights and scrolls into view.
- [ ] Click a tick on the scrubber → seek + highlight.
- [ ] Close playback window, reopen → resumes from t=0.
- [ ] Delete recording from list → MP4 disappears from `<app_data>/videos/`.
- [ ] Crash simulation: kill app mid-recording → restart → orphan MP4 with no matching id is cleaned up.
- [ ] macOS: revoke Screen Recording mid-session → alert fires, events still save.
- [ ] Legacy recording without `video` field → playback window opens in fallback mode.
- [ ] Change Settings fps/quality/audio → next recording reflects it.

- [ ] **Step: Final commit (if any fixes were needed during QA)**

```bash
git add -A
git commit -m "fix: polish from QA pass"
```

---

## Out of scope (deliberately deferred)

- Platform-native encoders (VideoToolbox / MediaFoundation)
- Storage caps / LRU eviction
- Display picker (multi-monitor)
- Auto-hide NSPanel during recording
- Export (GIF, MP4 with event burn-in)
- Trim / annotation editor
