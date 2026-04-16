# Preview Macro Recording with Screen Video + Live Events

Linear: [AUTO-14](https://linear.app/bnle/issue/AUTO-14/preview-macro-recording-with-screen-video-live-events)

## Goal

Record a screen video in sync with the existing event stream, and open a separate playback window that shows the video alongside a scrollable event list, with bidirectional scrubbing (click event → seek video; scrub video → highlight event).

## Scope

**In:**
- Primary-display screen capture via `scap`, H.264 MP4 output
- System audio capture on macOS 14.2+ and Windows (via `scap`)
- Always-capture (no opt-in toggle per recording)
- Separate resizable playback window (Screen Studio / openscreen pattern)
- Bidirectional sync: event list ↔ video ↔ scrubber with event markers
- Configurable quality (fps 15/30/60, low/med/high → CRF 32/28/23) in Settings
- Settings persistence to `settings.json` (new — current app has no persisted settings)

**Out:**
- Video editing (trim, crop, annotations)
- Export / sharing (GIF, upload)
- Webcam overlay, background effects, zoom effects
- Multi-monitor or display picker
- Audio on macOS < 14.2 (silent-only; documented)
- Storage caps / LRU eviction (user manages retention via delete)

## Architecture

### Data model

`VideoMetadata` is nested so presence is atomic and the struct is extensible.

```rust
// src-tauri/src/types.rs
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct VideoMetadata {
    pub path: String,         // relative to app data dir, e.g. "videos/1731..."
    pub start_ms: i64,        // UTC ms of frame 0 (sync anchor)
    pub duration_ms: i64,     // finalized duration
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub has_audio: bool,
}

pub struct Recording {
    pub id: String,
    pub name: String,
    pub events: Vec<InputEvent>,
    pub created_at: i64,
    pub playback_speed: f64,
    pub video: Option<VideoMetadata>,  // None on legacy / capture-failed
}
```

TypeScript mirrors. Missing field deserializes cleanly as `None`/`undefined`.

### Sync primitive

Event timestamps are `Utc::now().timestamp_millis()` (see [lib.rs:665](src-tauri/src/lib.rs#L665)). Video uses the same clock for its `t0`. Therefore:

```
time_in_video = (event.timestamp - video.start_ms) / 1000   // seconds
```

That's the whole sync system. No frame indexing, no interpolation.

### Recording lifecycle change

`recording_id` currently generated at save time ([lib.rs:93](src-tauri/src/lib.rs#L93)). Must move to `start_recording` so the video filename is known up front.

```
start_recording(state)
  → id = Utc::now().timestamp_millis().to_string()
  → state.current_id = Some(id)
  → capture_session.start(videos/{id}.mp4, t0 = Utc::now().timestamp_millis())
  → is_recording = true

stop_recording(state)
  → is_recording = false
  → video_meta = capture_session.stop()?   // finalizes MP4
  → return (events, video_meta, id)

save_recording(id, name, events, video_meta)
  → Recording { id, name, events, video: video_meta, ... }
  → append to recordings.json
```

### Capture module

```
src-tauri/src/
  capture.rs    # ScreenCaptureSession: start/stop, owns scap + encoder threads
  encoder.rs    # H.264 encoder wrapper, frame → MP4 muxer
  permissions.rs # TCC check for kTCCServiceScreenCapture (macOS only, cfg-gated)
```

**`ScreenCaptureSession`** — public API is exactly `start(config) -> Result<()>` and `stop() -> Result<VideoMetadata>`. Internal: a thread pulls frames from `scap`, feeds them through the encoder, muxes to MP4. A `CaptureSink` trait lets tests inject a fake sink.

**Encoder choice:** `openh264` crate (Cisco binary blob, freely distributable under their patent grant). Bundle size ~1-2MB. Documented follow-up: swap to platform-native encoders (VideoToolbox on macOS, MediaFoundation on Windows) to sidestep the license question entirely and get hardware acceleration.

**Audio:** `scap` supports system audio on macOS (ScreenCaptureKit ≥ 14.2) and Windows (WGC). If macOS < 14.2, fall back to silent video and set `has_audio: false`.

### Playback window

New Tauri window `playback` — standard decorated window, normal level, focusable (not an NSPanel). Default size 1200×750. Created on demand via `open_playback_window(recording_id)` command. Multiple instances allowed (one per recording reviewed).

The existing main window ("main") stays as the floating NSPanel recording controller — unchanged.

### Frontend structure

```
src/
  windows/
    playback.tsx                 # entry point (main.tsx analog for the playback window)
  components/playback/
    PlaybackView.tsx             # top-level layout: video | events, with scrubber below
    VideoPlayer.tsx              # <video> wrapper, exposes currentMs + seek()
    EventTimeline.tsx            # presentational scrubber w/ event tick markers
    SyncedEventList.tsx          # virtualized list, auto-scroll to active event
  hooks/
    usePlaybackSync.ts           # single owner of currentMs ↔ activeEventIndex
    useVideoAssetUrl.ts          # resolves videos/<id>.mp4 via Tauri asset protocol
```

**Isolation:**
- `usePlaybackSync` is the **only** place that owns bidirectional sync. Both `VideoPlayer` and `SyncedEventList` read/write through it. Keeps sync bugs to one file.
- `EventTimeline` is presentational — takes `events`, `durationMs`, `activeIndex`; emits `onSeek(ms)`. Zero knowledge of video element.
- `ScreenCaptureSession` — consumers see only `start`/`stop`. scap + encoder internals hidden.

### Sync mechanics (playback)

- **Click event → seek video:** `video.currentTime = (event.timestamp - video.start_ms) / 1000`
- **Video timeupdate → highlight event:** compute `currentMs = video.currentTime * 1000 + video.start_ms`. Binary-search events (sorted by construction) for nearest-by-timestamp. Update `activeEventIndex`. Scroll list into view unless user manually scrolled recently (match the existing `useAutoScroll` pattern).
- **Scrubber ticks:** `events.map(e => ((e.timestamp - video.start_ms) / video.duration_ms) * scrubberWidth)`, colored by event type. Hover shows event detail. Click tick → `onSeek`. `MouseMove` events throttled in the tick layer (same throttling idea as existing `useRecorder`).
- **Why binary search:** 5-min recording can be thousands of events; browser `timeupdate` fires ~4Hz; O(n) per tick is wasteful. Events are time-sorted so `lowerBound` is O(log n).

### Settings

Introduce `settings.json` in app data dir (new pattern — current app persists nothing except theme via localStorage):

```ts
interface AppSettings {
  capture: {
    fps: 15 | 30 | 60;              // default 30
    quality: 'low' | 'med' | 'high'; // default 'med' → CRF 28
    audio: boolean;                  // default true (macOS 14.2+ / Windows)
  };
}
```

Rust commands: `load_settings()` / `save_settings(settings)`. Frontend hook `useAppSettings()` caches in-memory. Existing Settings tab gains a "Capture" section.

### Tauri config

- `tauri.conf.json` — register the `playback` window config.
- Asset protocol scope: grant read access to `videos/**` within app data dir so `<video>` can stream via `convertFileSrc`.
- `capabilities/default.json` — grant `asset:read` for the scoped path.

## Permissions

### macOS
- **Screen Recording** (`kTCCServiceScreenCapture`): check before first capture. If denied, emit `permission-needed` event → frontend extends the existing permissions guide with a Screen Recording entry + "Open System Settings" button deep-linking to `x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture`. Surface that macOS requires app restart after granting.
- **System Audio**: bundled with Screen Recording on macOS 14.2+. No extra TCC. Silently degrade on older versions.
- Accessibility flow (existing `rdev`) stays separate.

### Windows
- WGC requires no permission. Audio tap requires no permission.

### Timing
- Lazy: only check on first Start Recording after install. Don't block app launch.

## Error handling

| Failure | Behavior |
|---|---|
| Permission denied at start | Abort recording, show guide, don't create recording entry |
| Capture fails mid-recording (disk full, permission revoked) | Keep event stream, stop capture cleanly, save recording with `video: None`, toast "Video capture failed — events saved" |
| Encoder error on finalize | Delete partial MP4, save with `video: None`, same toast |
| Video file missing on playback open | Open window, show event-list-only with banner "Video file not found" |
| `<video>` decode fails | Same as missing file |
| App closes mid-recording | Best-effort finalize via Drop on `ScreenCaptureSession`. If it fails, file GC'd on next launch |
| Orphaned MP4s (no matching recording in `recordings.json`) | Sweep at app start: `videos/*.mp4` where id ∉ recordings → delete |
| Delete recording | Also delete `videos/<id>.mp4` |

## NSPanel visibility during recording

The floating NSPanel will appear in captured video (it's always-on-top). For MVP: **leave visible, rely on `Cmd+M` for user to hide**. Auto-hide breaks the Stop-button workflow. Revisit if beta testers complain.

## Testing

### Rust
- `capture.rs`: inject fake `CaptureSink`, verify start/stop/error-propagation without real scap.
- `encoder.rs`: feed synthetic frames, assert valid MP4 header/duration (parse with `mp4` crate).
- `permissions.rs`: mock TCC call, verify event emission on denial.
- Integration: real `scap` capture for 2s, assert MP4 exists and has correct duration.

### Frontend (Vitest)
- `usePlaybackSync`: given events + currentMs → correct activeIndex; seek propagates correctly; no feedback loops on scrub.
- `EventTimeline`: snapshot of marker positions given events + duration.

### Manual QA (in spec — run before merging)
- [ ] Record → stop → MP4 exists in app data
- [ ] Open playback window → video plays with audio (macOS 14.2+)
- [ ] Click event → video seeks accurately (±100ms)
- [ ] Scrub video → event list auto-scrolls, active event highlighted
- [ ] Click tick marker on scrubber → seek + highlight
- [ ] Close playback window, reopen → resumes from t=0
- [ ] Delete recording → MP4 deleted
- [ ] Crash mid-recording → orphan cleaned up on next launch
- [ ] macOS: deny screen recording permission → guide shown, no partial file
- [ ] macOS < 14.2: video records without audio, `has_audio: false`, no error
- [ ] Legacy recording (no `video` field) → playback window opens in fallback mode
- [ ] Settings: change fps/quality/audio → new recordings reflect it

### CI (GitHub Actions, existing macOS + Windows)
- Add smoke test: spawn app, record 2s, assert MP4 exists with valid header.

## Files

### New
- `src-tauri/src/capture.rs`
- `src-tauri/src/encoder.rs`
- `src-tauri/src/permissions.rs`
- `src-tauri/src/settings.rs`
- `src/windows/playback.tsx`
- `src/windows/playback.html` (Vite entry)
- `src/components/playback/PlaybackView.tsx`
- `src/components/playback/VideoPlayer.tsx`
- `src/components/playback/EventTimeline.tsx`
- `src/components/playback/SyncedEventList.tsx`
- `src/hooks/usePlaybackSync.ts`
- `src/hooks/useVideoAssetUrl.ts`
- `src/hooks/useAppSettings.ts`

### Modified
- `src-tauri/src/lib.rs` — capture-aware start/stop, `open_playback_window` command, `load_settings`/`save_settings` commands, orphan sweep on startup, delete also removes MP4
- `src-tauri/src/types.rs` — add `VideoMetadata`, update `Recording`, add `AppSettings`
- `src-tauri/Cargo.toml` — add `scap`, `openh264`, `mp4`
- `src-tauri/tauri.conf.json` — playback window config, asset protocol scope for `videos/**`
- `src-tauri/capabilities/default.json` — asset read scope
- `src/types.ts` — mirror `VideoMetadata`, `AppSettings`
- `src/components/RecordingsList.tsx` — "view recording" button opens playback window
- `src/components/SettingsTab.tsx` — capture section (fps / quality / audio toggle)
- `vite.config.ts` — multi-entry for playback window

## Follow-ups (not this PR)

- Platform-native encoders (VideoToolbox / MediaFoundation) — hardware accelerated, sidesteps openh264 license
- Storage cap + LRU eviction
- Display picker for multi-monitor
- Auto-hide NSPanel during recording (if users want it)
- Export playback (GIF, MP4 with event overlay burned in)
- Trim / annotation editor
