# Macroni — Architecture Context

Short orientation for someone reading the code cold. Covers things the
files themselves don't tell you: where modules draw their lines, why
the splits exist, and what's intentional.

For detailed rationale on individual decisions, see `docs/adrs/`.

## Layout

- `src-tauri/src/` — Rust backend (Tauri commands, capture, playback).
- `src/` — React frontend (TS + Vite + Tailwind v4).

## Rust modules

```
lib.rs                    Tauri command surface + window/shortcut wiring
├── types                 InputEvent enum, Recording, VideoMetadata, RecordingState
├── key_mapping           rdev::Key ⇄ string, modifier detection, combo lookup
├── settings              settings.json IO
├── crash_log             panic hook → crash.log on disk
├── permissions           macOS screen-recording entitlement probe
├── capture               ScreenCaptureSession (scap → BGRA → MP4 sink)
├── encoder               H.264 + AAC MP4 encoder sink
├── recordings_store      recordings.json IO + associated video lifecycle
├── event_capture         rdev::EventType → InputEvent translation + state machines
├── recording_session     active-recording state machine (idle | active)
└── playback
    ├── plan              pure compiled timeline (no threads, no I/O)
    ├── engine            driver: pumps a plan against ports, owns playback state
    └── ports             Simulator / Emitter traits + Rdev/Tauri real impls
```

`RecordingState` (`types.rs`) is just `{ session, engine }` — two cohesive
halves managed by `recording_session` and `playback::engine`. There is
no other shared mutable state.

## Ports (test seams)

- **CaptureSink** (`capture.rs`) — real `Mp4EncoderSink` vs. test `FakeSink`.
- **Simulator** (`playback/ports.rs`) — real `RdevSimulator` vs. test `FakeSimulator`.
- **Emitter** (`playback/ports.rs`) — real `TauriEmitter` vs. test `FakeEmitter`.

`RecordingsStore` does not use a polymorphic seam; tests use
`RecordingsStore::open_at(tempdir)` instead of mocking `AppHandle`.

## Vocabulary

- **Recording** — a saved sequence of `InputEvent`s, optionally with a video.
- **InputEvent** — one of: KeyPress, KeyRelease, KeyCombo, ButtonPress, ButtonRelease, MouseMove.
- **KeyCombo** — annotation event riding alongside a real KeyPress when modifiers + a non-modifier produced a recognised character. Combos update playback position but are never simulated on replay.
- **RecordingSession** — the "are we recording right now?" state machine. Listener thread reads `is_active()` (lock-free); start/stop and `push_event` go through a `Mutex<SessionState>`.
- **PlaybackPlan** — compiled, immutable sequence of `PlannedStep`s for one iteration. Holds every timing/throttling decision.
- **PlannedStep** — atomic unit: `EmitPosition` / `Sleep` / `Simulate`.
- **PlaybackEngine** — drives a plan against `Simulator` + `Emitter` ports. Owns `is_playing` (AtomicBool), `position`, `loop_count`.

## Invariants you can rely on

- `RecordingSession::is_active()` ⇔ inner state is `Active`.
- `recordings.json` writes are atomic (tempfile + rename); a crashed mid-write leaves the previous valid file intact.
- Playback plans never include simulation steps for `KeyCombo` events.
- The listener thread is single-owner of all input state machines (`EventCapture`'s modifier/button/mouse fields are plain `HashSet`/`Option`, not behind any mutex).
- `recordings_store::sweep_orphan_videos` runs at startup and reconciles `videos/*.mp4` against `recordings.json`.

## Platform notes

- **Windows**: `ScreenCaptureSession::start` returns `Err("windows-capture-unsupported")` because scap 0.1.0-beta.1 doesn't compile against the current `windows-capture` dep. Event recording still works; video capture is skipped. Revisit when upstream scap fixes it.
- **macOS**: requires Screen Recording (for capture) and Accessibility (for `rdev::listen`) permissions. Both are surfaced through Tauri events (`permission-needed`, `capture-failed`).

## Frontend ↔ Backend events

Tauri-emitted (Rust → JS):
- `input-event` — every captured `InputEvent` (live display).
- `playback-position` — `usize` index into the events array.
- `playback-loop-restart` — emitted between iterations when `loop_forever`.
- `playback-complete` — emitted when playback finishes or is stopped.
- `playback-stopped` — emitted from the global shortcut path when Cmd/Ctrl+R cancels playback.
- `permission-needed` — payload `"screen-recording"`.
- `capture-failed` — payload is a human-readable error string.
- `toggle-recording`, `toggle-playback` — global shortcut → frontend.

JS-invoked Tauri commands are all defined at the top of `lib.rs`.
