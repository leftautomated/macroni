# Loop Forever Playback + Cmd+R Toggle

## Goal

Recordings loop forever by default during playback. Global shortcut Cmd+R toggles play/stop on the currently selected recording.

## Design

### Rust Backend

**`play_recording` command** — add `loop_forever: bool` param (default `true`):
- Wrap event iteration in `loop { ... break if !loop_forever }`
- Between loops: emit `playback-loop-restart` event, reset position to 0, 50ms gap
- `playback-complete` only fires when actually stopped or non-looping playback finishes

**`RecordingState`** — add `loop_count: Arc<Mutex<usize>>`:
- Incremented each loop restart
- Reset on `stop_playback`
- Exposed for future agent observability

**Global shortcut** — register `Cmd+R` (macOS) / `Ctrl+R` (other):
- Handler emits `toggle-playback` event to frontend
- Frontend owns "which recording is selected" — Rust just signals the intent

### Frontend

**`RecordingDetail.tsx`**:
- Listen for `toggle-playback` event → call handlePlay or handleStop
- Pass `loop_forever: true` to `play_recording` invoke

**`usePlaybackPosition`**:
- Listen for `playback-loop-restart` event → reset position to 0

### Files to modify

1. `src-tauri/src/types.rs` — add `loop_count` to `RecordingState`
2. `src-tauri/src/lib.rs` — loop logic in playback thread, `Cmd+R` shortcut, `toggle-playback` event
3. `src/components/RecordingDetail.tsx` — `toggle-playback` listener, pass `loop_forever`
4. `src/hooks/usePlaybackPosition.ts` — handle `playback-loop-restart`

### What stays the same

- `stop_playback` — sets `is_playing = false`, thread checks and breaks
- `is_playing` polling — unchanged
- Event format — no changes to `InputEvent` enum
