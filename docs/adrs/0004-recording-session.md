# ADR 0004: Consolidate active-recording state into `RecordingSession`

- Status: Accepted
- Date: 2026-05-16

## Context

After ADRs 0001–0003 landed, `RecordingState` still carried four loose
mutex-wrapped fields for the recording side of the app:

- `is_recording: Arc<Mutex<bool>>`
- `current_events: Arc<Mutex<Vec<InputEvent>>>`
- `current_id: Arc<Mutex<Option<String>>>`
- `capture_session: Arc<Mutex<Option<ScreenCaptureSession>>>`

These were always touched in lockstep but the type system didn't enforce any
relationship between them — nothing prevented "is_recording=true with no
current_id", or vice versa. A fifth field, `last_video_meta`, was written by
`stop_recording` but never read anywhere.

## Decision

Replace the four fields with one `recording_session::RecordingSession` whose
internal state is a two-variant enum:

```rust
enum SessionState {
    Idle,
    Active { id: String, events: Vec<InputEvent>, capture: Option<ScreenCaptureSession> },
}
```

Wrapped behind a `Mutex<SessionState>` plus a separate `AtomicBool` for the
listener-thread hot path. The hot-path read (`is_active()`) is lock-free —
critical because the rdev listener calls it before every event. The mutex
only serializes the rare start/stop transitions and `push_event`, which is
already gated by the AtomicBool.

Public API: `new`, `is_active`, `start(id, capture)`, `push_event(event)`,
`stop() -> StoppedSession`, `current_id`. Start/stop errors are typed
(`AlreadyActive` / `NotActive`).

`push_event` is a no-op when idle — covers in-flight rdev events that arrive
after `stop_recording` flipped the flag.

Drop `last_video_meta` entirely — it was unused.

## Consequences

- `RecordingState` now has exactly two fields: `session` and `engine`. Each
  is a cohesive unit, not a bag of mutexes.
- The state-machine invariant "active iff id and event buffer exist together"
  is enforced by construction; impossible states are unrepresentable.
- The listener thread's "are we recording?" check becomes a lock-free
  `AtomicBool::load`.
- Stop-race resilience: in-flight events after `stop` are silently dropped
  rather than corrupting a started-but-not-yet-active session.
- 10 unit tests cover lifecycle, error cases, and event ordering.
- Dead `last_video_meta` removed.
