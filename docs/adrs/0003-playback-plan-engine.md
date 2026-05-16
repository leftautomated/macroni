# ADR 0003: Split playback into `PlaybackPlan` + `PlaybackEngine`

- Status: Accepted
- Date: 2026-05-15

## Context

`play_recording` was a 250-line function that fused:

- State coordination across three `Arc<Mutex<…>>` fields (`is_playing`,
  `playback_position`, `loop_count`).
- Thread spawning and cancellation polling.
- Per-event UI-update throttling (the every-3rd-`MouseMove` rule).
- Timing math: delay derivation, speed scaling, overhead subtraction,
  per-event-type min-delay floors.
- rdev simulation including the "ButtonPress = MouseMove → sleep → Press"
  three-step expansion.
- Tauri emission for position, loop-restart, completion.

None of the throttling/timing rules were testable without spawning a real
thread and synthesising real OS input. The function had no tests.

## Decision

Split into three concerns:

- **`playback::plan::PlaybackPlan`** — pure. `compile(events, speed)` returns
  a flat `Vec<PlannedStep>` for one iteration. `PlannedStep` is the smallest
  atomic unit: `EmitPosition { index }`, `Sleep { ms }`, or `Simulate(EventType)`.
  All throttling, scaling, min-delay, and pre-move-then-press rules live here.
  Fully unit-testable: feed events, assert step sequence.

- **`playback::engine::PlaybackEngine`** — driver. ~50-line loop that pumps
  a plan against ports. Owns playback state (`is_playing: AtomicBool`,
  `position: Mutex<Option<usize>>`, `loop_count: AtomicUsize`). Cancellation
  checks happen between every step; long `Sleep`s are chunked to remain
  cancellable.

- **`playback::ports`** — `Simulator` and `Emitter` traits. Real impls
  (`RdevSimulator`, `TauriEmitter`) and test fakes (`FakeSimulator`,
  `FakeEmitter`) both ship from the same module.

Compile errors (`Empty`, `AllKeyCombos`) surface eagerly at `compile()` so
the engine never starts a doomed run.

The compiled `Vec<PlannedStep>` approach was chosen over a streaming iterator
because the memory cost (~50 bytes × N events) is irrelevant for a desktop
app, and the test surface is much cleaner ("assert the whole timeline" vs.
"step the iterator with a fake clock"). If profiling later shows it matters
on million-event recordings, switch to an iterator without rewriting tests.

## Consequences

- Tauri `play_recording` command shrinks to ~10 lines.
- Three `Mutex` fields move off `RecordingState` into the engine, where they
  are coordinated as one unit.
- 17 unit tests (11 plan + 6 engine) cover timing rules, throttling, speed
  scaling, pre-move-then-press, cancellation, loop restart, and completion.
- Future "headless replay" or "save plan to disk" is trivial — the plan is
  just data.
- The shortcut handler now calls `engine.stop()` instead of poking the
  `is_playing` mutex directly.
