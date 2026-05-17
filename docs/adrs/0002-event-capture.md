# ADR 0002: Extract `EventCapture` from the rdev listener closure

- Status: Accepted
- Date: 2026-05-15

## Context

The rdev `listen` callback inside `lib.rs::run()::setup()` was 130 lines and
mixed five concerns:

1. Reading whether we should be recording.
2. Maintaining a modifier `HashSet<Key>` and button `HashSet<Button>` plus
   last-known mouse position — each behind its own `Arc<Mutex>` on
   `RecordingState`.
3. Translating `rdev::EventType` → `InputEvent`.
4. Combo recognition (modifiers + non-modifier → recognised char).
5. Drag-detection filter (suppress `MouseMove` unless a button is held).

State machines lived in three separate mutexes touched only from the listener
thread, despite being conceptually one piece of state. None of the
translation rules were unit-testable; the only way to verify combo
recognition was to tap real keys.

## Decision

Introduce `event_capture::EventCapture` owning modifier set, button set, and
last mouse position as plain non-locked fields (single-owner: the listener
thread). Public API:

```rust
fn on_rdev_event(&mut self, event_type: EventType, timestamp_ms: i64) -> Vec<InputEvent>;
```

A single rdev event produces 0–2 `InputEvent`s (e.g., a non-modifier key with
modifiers held produces both a `KeyPress` and a `KeyCombo`).

Returning a small `Vec` rather than a callback closure was chosen for test
ergonomics — allocation for 0–2 items at rdev's event rate is bump-pointer
cheap. If profiling later shows it matters, switch to a callback without
restructuring tests.

## Consequences

- The listener closure shrinks from ~130 lines to ~12.
- Three `Arc<Mutex<…>>` fields disappear from `RecordingState`.
- 10 unit tests cover combo recognition, drag filter, position fallback,
  stale-modifier handling.
- Module state is single-threaded by construction — no race conditions
  possible.
