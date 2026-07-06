//! Drives a `PlaybackPlan` against `Simulator` and `Emitter` ports. Owns the
//! playback state machine (`is_playing`, current position, loop count). All
//! timing/throttling decisions live in the plan; the engine just sleeps,
//! emits, simulates, and polls for cancellation.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use super::plan::{PlannedStep, PlaybackPlan};
use super::ports::{Emitter, Simulator};

/// 100ms warmup before the first iteration — gives UI listeners time to wire up.
const WARMUP_MS: u64 = 100;
/// 50ms gap inserted between iterations when looping.
const LOOP_RESTART_GAP_MS: u64 = 50;

pub struct PlaybackEngine {
    is_playing: Arc<AtomicBool>,
    position: Arc<Mutex<Option<usize>>>,
    loop_count: Arc<AtomicUsize>,
}

impl PlaybackEngine {
    pub fn new() -> Self {
        Self {
            is_playing: Arc::new(AtomicBool::new(false)),
            position: Arc::new(Mutex::new(None)),
            loop_count: Arc::new(AtomicUsize::new(0)),
        }
    }

    pub fn is_playing(&self) -> bool {
        self.is_playing.load(Ordering::Relaxed)
    }
    #[allow(dead_code)] // read in unit tests; exposed for future Tauri command needs
    pub fn position(&self) -> Option<usize> {
        self.position.lock().ok().and_then(|p| *p)
    }
    #[allow(dead_code)] // read in unit tests; exposed for future Tauri command needs
    pub fn loop_count(&self) -> usize {
        self.loop_count.load(Ordering::Relaxed)
    }

    pub fn stop(&self) {
        self.is_playing.store(false, Ordering::Relaxed);
        if let Ok(mut p) = self.position.lock() {
            *p = None;
        }
        self.loop_count.store(0, Ordering::Relaxed);
    }

    /// Claim the playback slot for a macro run (mutually exclusive with
    /// `start`). Errors if playback or another macro already holds it.
    /// Release by storing `false` into the returned flag (or via `stop()`,
    /// which the macro runner observes to cancel).
    #[allow(dead_code)] // consumed by Task 4 (macro runner)
    pub(crate) fn claim_for_macro(&self) -> Result<Arc<AtomicBool>, String> {
        if self.is_playing.swap(true, Ordering::Relaxed) {
            return Err("Already playing".to_string());
        }
        Ok(Arc::clone(&self.is_playing))
    }

    /// Begin playback. Spawns a worker thread; returns immediately.
    /// Errors if already playing.
    pub fn start(
        &self,
        plan: PlaybackPlan,
        loop_forever: bool,
        simulator: impl Simulator,
        emitter: impl Emitter,
    ) -> Result<(), String> {
        if self.is_playing.swap(true, Ordering::Relaxed) {
            return Err("Already playing".to_string());
        }
        if let Ok(mut p) = self.position.lock() {
            *p = None;
        }
        self.loop_count.store(0, Ordering::Relaxed);

        let is_playing = Arc::clone(&self.is_playing);
        let position = Arc::clone(&self.position);
        let loop_count = Arc::clone(&self.loop_count);

        thread::spawn(move || {
            run_plan(
                plan,
                loop_forever,
                &is_playing,
                &position,
                &loop_count,
                simulator,
                emitter,
            );
        });

        Ok(())
    }
}

impl Default for PlaybackEngine {
    fn default() -> Self {
        Self::new()
    }
}

fn run_plan(
    plan: PlaybackPlan,
    loop_forever: bool,
    is_playing: &AtomicBool,
    position: &Mutex<Option<usize>>,
    loop_count: &AtomicUsize,
    simulator: impl Simulator,
    emitter: impl Emitter,
) {
    // Warmup so UI subscribers have a chance to attach.
    if !sleep_cancellable(WARMUP_MS, is_playing) {
        return finalize(emitter, is_playing, position, loop_count);
    }

    let mut is_first_iteration = true;
    loop {
        if !is_playing.load(Ordering::Relaxed) {
            break;
        }

        if !is_first_iteration {
            loop_count.fetch_add(1, Ordering::Relaxed);
            if let Ok(mut p) = position.lock() {
                *p = Some(0);
            }
            emitter.emit_loop_restart();
            if !sleep_cancellable(LOOP_RESTART_GAP_MS, is_playing) {
                break;
            }
        }
        is_first_iteration = false;

        let completed = execute_steps(&plan.steps, is_playing, &simulator, |i| {
            if let Ok(mut p) = position.lock() {
                *p = Some(i);
            }
            emitter.emit_position(i);
        });

        if !completed || !loop_forever {
            break;
        }
    }

    finalize(emitter, is_playing, position, loop_count);
}

/// Execute a single iteration's worth of steps against `simulator`,
/// reporting each `EmitPosition` step's index via `on_position` and
/// bailing as soon as `cancel` flips false. Returns whether every step
/// ran to completion (`true`) or the run was cut short by cancellation
/// (`false`).
#[allow(dead_code)] // consumed by Task 4 (macro runner)
pub(crate) fn execute_steps(
    steps: &[PlannedStep],
    cancel: &AtomicBool,
    simulator: &impl Simulator,
    mut on_position: impl FnMut(usize),
) -> bool {
    let mut completed = true;
    for step in steps {
        if !cancel.load(Ordering::Relaxed) {
            completed = false;
            break;
        }
        match step {
            PlannedStep::EmitPosition { index } => {
                on_position(*index);
            }
            PlannedStep::Sleep { ms } => {
                if !sleep_cancellable(*ms, cancel) {
                    completed = false;
                    break;
                }
            }
            PlannedStep::Simulate(event_type) => {
                // Re-check cancellation right before firing the OS-level
                // input event. Without this, a stop() that lands while the
                // worker is between the for-loop guard and the simulate
                // call can still inject a final event into the OS after
                // the frontend has been told playback-stopped.
                if !cancel.load(Ordering::Relaxed) {
                    completed = false;
                    break;
                }
                if let Err(e) = simulator.simulate(*event_type) {
                    crate::observability::log_error("playback", "simulate_event_failed", &e, None);
                }
            }
        }
    }
    completed
}

fn finalize(
    emitter: impl Emitter,
    is_playing: &AtomicBool,
    position: &Mutex<Option<usize>>,
    loop_count: &AtomicUsize,
) {
    is_playing.store(false, Ordering::Relaxed);
    if let Ok(mut p) = position.lock() {
        *p = None;
    }
    loop_count.store(0, Ordering::Relaxed);
    emitter.emit_complete();
}

/// Sleep `ms` in small chunks, bailing if `is_playing` flips to false. Returns
/// `true` if we slept the full duration, `false` if cancelled.
pub(crate) fn sleep_cancellable(ms: u64, is_playing: &AtomicBool) -> bool {
    if ms == 0 {
        return is_playing.load(Ordering::Relaxed);
    }
    const CHUNK_MS: u64 = 10;
    let mut remaining = ms;
    while remaining > 0 {
        if !is_playing.load(Ordering::Relaxed) {
            return false;
        }
        let chunk = remaining.min(CHUNK_MS);
        thread::sleep(Duration::from_millis(chunk));
        remaining = remaining.saturating_sub(chunk);
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::playback::plan::PlannedStep;
    use rdev::{EventType, Key};
    use std::sync::Mutex as StdMutex;
    use std::time::Instant;

    #[derive(Default, Clone)]
    struct FakeSimulator {
        calls: Arc<StdMutex<Vec<EventType>>>,
    }
    impl Simulator for FakeSimulator {
        fn simulate(&self, event_type: EventType) -> Result<(), String> {
            self.calls.lock().unwrap().push(event_type);
            Ok(())
        }
    }

    #[derive(Default, Clone)]
    struct FakeEmitter {
        positions: Arc<StdMutex<Vec<usize>>>,
        restarts: Arc<StdMutex<usize>>,
        completes: Arc<StdMutex<usize>>,
    }
    impl Emitter for FakeEmitter {
        fn emit_position(&self, index: usize) {
            self.positions.lock().unwrap().push(index);
        }
        fn emit_loop_restart(&self) {
            *self.restarts.lock().unwrap() += 1;
        }
        fn emit_complete(&self) {
            *self.completes.lock().unwrap() += 1;
        }
    }

    /// A short plan that runs in ~0ms (no Sleep steps).
    fn trivial_plan() -> PlaybackPlan {
        PlaybackPlan {
            steps: vec![
                PlannedStep::EmitPosition { index: 0 },
                PlannedStep::Simulate(EventType::KeyPress(Key::KeyA)),
            ],
        }
    }

    fn wait_until_idle(engine: &PlaybackEngine, max_ms: u64) {
        let deadline = Instant::now() + Duration::from_millis(max_ms);
        while engine.is_playing() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(5));
        }
    }

    fn wait_until_position(engine: &PlaybackEngine, want: usize, max_ms: u64) -> bool {
        let deadline = Instant::now() + Duration::from_millis(max_ms);
        while Instant::now() < deadline {
            if engine.position() == Some(want) {
                return true;
            }
            thread::sleep(Duration::from_millis(5));
        }
        false
    }

    #[test]
    fn start_runs_plan_and_emits_complete() {
        let engine = PlaybackEngine::new();
        let sim = FakeSimulator::default();
        let emit = FakeEmitter::default();
        let sim_calls = Arc::clone(&sim.calls);
        let positions = Arc::clone(&emit.positions);
        let completes = Arc::clone(&emit.completes);
        engine.start(trivial_plan(), false, sim, emit).unwrap();
        wait_until_idle(&engine, 1000);
        assert!(!engine.is_playing());
        assert_eq!(sim_calls.lock().unwrap().len(), 1);
        assert_eq!(positions.lock().unwrap().clone(), vec![0]);
        assert_eq!(*completes.lock().unwrap(), 1);
    }

    #[test]
    fn cannot_start_twice() {
        let engine = PlaybackEngine::new();
        let plan = PlaybackPlan {
            steps: vec![PlannedStep::Sleep { ms: 500 }],
        };
        engine
            .start(
                plan,
                false,
                FakeSimulator::default(),
                FakeEmitter::default(),
            )
            .unwrap();
        let second = engine.start(
            PlaybackPlan { steps: vec![] },
            false,
            FakeSimulator::default(),
            FakeEmitter::default(),
        );
        assert!(second.is_err());
        engine.stop();
        wait_until_idle(&engine, 1000);
    }

    #[test]
    fn stop_cancels_mid_sleep_quickly() {
        let engine = PlaybackEngine::new();
        let plan = PlaybackPlan {
            steps: vec![PlannedStep::Sleep { ms: 10_000 }],
        };
        let sim = FakeSimulator::default();
        let emit = FakeEmitter::default();
        let started = Instant::now();
        engine.start(plan, false, sim, emit).unwrap();
        thread::sleep(Duration::from_millis(50));
        engine.stop();
        wait_until_idle(&engine, 1000);
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "stop should bail out quickly"
        );
        assert!(!engine.is_playing());
    }

    #[test]
    fn loop_forever_replays_plan_with_restart_emit_and_gap() {
        // Generous time budget to survive cargo's parallel test scheduler:
        // ~100ms warmup + ~50ms gap per iteration. 3s should comfortably fit
        // many iterations even on a contended runner.
        let engine = PlaybackEngine::new();
        let sim = FakeSimulator::default();
        let emit = FakeEmitter::default();
        let sim_calls = Arc::clone(&sim.calls);
        let restarts = Arc::clone(&emit.restarts);
        engine.start(trivial_plan(), true, sim, emit).unwrap();
        thread::sleep(Duration::from_millis(3000));
        engine.stop();
        wait_until_idle(&engine, 2000);
        let n_sims = sim_calls.lock().unwrap().len();
        let n_restarts = *restarts.lock().unwrap();
        assert!(
            n_sims >= 2,
            "expected multiple iterations, got {} simulate calls",
            n_sims
        );
        assert!(
            n_restarts >= 1,
            "expected at least one loop-restart emit, got {}",
            n_restarts
        );
    }

    #[test]
    fn position_reflects_current_step_index() {
        // Long sleep windows so the observation point is comfortably mid-window
        // even when cargo's parallel runner contends for CPU.
        let engine = PlaybackEngine::new();
        let plan = PlaybackPlan {
            steps: vec![
                PlannedStep::EmitPosition { index: 0 },
                PlannedStep::Sleep { ms: 2000 },
                PlannedStep::EmitPosition { index: 1 },
                PlannedStep::Sleep { ms: 2000 },
            ],
        };
        let sim = FakeSimulator::default();
        let emit = FakeEmitter::default();
        engine.start(plan, false, sim, emit).unwrap();
        // Poll for position=0 rather than time-based wait so the test survives
        // contended schedulers (cargo's parallel runner can starve the worker
        // thread past a fixed sleep).
        assert!(
            wait_until_position(&engine, 0, 3000),
            "engine never reported position=0 within 3s"
        );
        engine.stop();
        wait_until_idle(&engine, 2000);
    }

    #[test]
    fn position_resets_to_none_after_complete() {
        let engine = PlaybackEngine::new();
        engine
            .start(
                trivial_plan(),
                false,
                FakeSimulator::default(),
                FakeEmitter::default(),
            )
            .unwrap();
        wait_until_idle(&engine, 1000);
        assert_eq!(engine.position(), None);
        assert_eq!(engine.loop_count(), 0);
    }

    // The tests below close mutation-testing gaps in run_plan's control flow.

    #[test]
    fn stop_during_pre_simulate_sleep_prevents_the_simulate_from_firing() {
        // Models the original bug: a plan like [Sleep, Simulate] where stop()
        // arrives during the sleep. After the cancellation re-check inside
        // the Simulate arm, the simulate must NOT fire.
        let engine = PlaybackEngine::new();
        let sim = FakeSimulator::default();
        let sim_calls = Arc::clone(&sim.calls);
        let emit = FakeEmitter::default();
        // Long sleep so we can reliably stop during it on a contended runner.
        let plan = PlaybackPlan {
            steps: vec![
                PlannedStep::Sleep { ms: 1500 },
                PlannedStep::Simulate(EventType::KeyPress(Key::KeyA)),
            ],
        };
        engine.start(plan, false, sim, emit).unwrap();
        // After warmup (100ms), the worker is in the long Sleep. Stop it.
        thread::sleep(Duration::from_millis(200));
        engine.stop();
        wait_until_idle(&engine, 2000);
        // Even though the sleep was cancelled, the simulate must not have
        // fired. The Sleep arm sets completed=false and breaks before the
        // for loop reaches Simulate — but we also assert the post-sleep
        // re-check would catch it if the Sleep arm guard were ever removed.
        assert_eq!(
            sim_calls.lock().unwrap().len(),
            0,
            "simulate must not fire after stop is called during the preceding sleep"
        );
    }

    #[test]
    fn sleep_step_yields_to_following_simulate_step() {
        // A plan with [Sleep, Simulate] must execute both. A mutation that
        // flips the cancellation check on the Sleep step would mark the
        // iteration as cancelled after a successful sleep and skip the
        // simulate. Pins line 143.
        let engine = PlaybackEngine::new();
        let sim = FakeSimulator::default();
        let sim_calls = Arc::clone(&sim.calls);
        let emit = FakeEmitter::default();
        let plan = PlaybackPlan {
            steps: vec![
                PlannedStep::Sleep { ms: 30 },
                PlannedStep::Simulate(EventType::KeyPress(Key::KeyA)),
            ],
        };
        engine.start(plan, false, sim, emit).unwrap();
        wait_until_idle(&engine, 2000);
        assert_eq!(
            sim_calls.lock().unwrap().len(),
            1,
            "the simulate after a successful sleep must run"
        );
    }

    #[test]
    fn single_iteration_emits_no_loop_restart() {
        // loop_forever=false on a trivial plan should produce exactly zero
        // loop-restart emits. Pins line 117 — a mutation that flips
        // `if !is_first_iteration` would treat the first iteration as a
        // restart and emit one.
        let engine = PlaybackEngine::new();
        let emit = FakeEmitter::default();
        let restarts = Arc::clone(&emit.restarts);
        engine
            .start(trivial_plan(), false, FakeSimulator::default(), emit)
            .unwrap();
        wait_until_idle(&engine, 1000);
        assert_eq!(
            *restarts.lock().unwrap(),
            0,
            "no restart emit expected for a single, non-looping iteration"
        );
    }

    #[test]
    fn loop_count_observable_mid_run() {
        // Mid-run, loop_count must reflect completed iterations. Pins line 43
        // (loop_count accessor) — a mutation returning a constant 0 would
        // mask repeat iterations.
        let engine = PlaybackEngine::new();
        engine
            .start(
                trivial_plan(),
                true, // loop forever
                FakeSimulator::default(),
                FakeEmitter::default(),
            )
            .unwrap();
        // Wait for at least one loop restart to land (after the first
        // iteration: loop_count goes 0 -> 1). Each iteration takes ~50ms gap
        // + trivial steps; 3s budget for parallel-test contention.
        let deadline = Instant::now() + Duration::from_secs(3);
        let mut observed = 0;
        while Instant::now() < deadline {
            let now = engine.loop_count();
            if now > 0 {
                observed = now;
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        engine.stop();
        wait_until_idle(&engine, 2000);
        assert!(
            observed > 0,
            "loop_count never reported a value above 0 during a looping run"
        );
    }

    #[test]
    fn claim_for_macro_excludes_playback_and_stop_releases() {
        let engine = PlaybackEngine::new();
        let flag = engine.claim_for_macro().unwrap();
        assert!(engine.is_playing());
        // Playback cannot start while a macro holds the slot.
        assert!(engine
            .start(
                trivial_plan(),
                false,
                FakeSimulator::default(),
                FakeEmitter::default()
            )
            .is_err());
        // A second macro cannot claim either.
        assert!(engine.claim_for_macro().is_err());
        // engine.stop() flips the shared flag — the macro runner sees it.
        engine.stop();
        assert!(!flag.load(Ordering::Relaxed));
        // Slot reusable after release.
        assert!(engine.claim_for_macro().is_ok());
        engine.stop();
    }

    #[test]
    fn execute_steps_runs_and_respects_cancellation() {
        let sim = FakeSimulator::default();
        let calls = Arc::clone(&sim.calls);
        let cancel = AtomicBool::new(true);
        let mut positions = Vec::new();
        let steps = vec![
            PlannedStep::EmitPosition { index: 7 },
            PlannedStep::Simulate(EventType::KeyPress(Key::KeyA)),
        ];
        assert!(execute_steps(&steps, &cancel, &sim, |i| positions.push(i)));
        assert_eq!(calls.lock().unwrap().len(), 1);
        assert_eq!(positions, vec![7]);
        // Cancelled flag short-circuits before simulating.
        cancel.store(false, Ordering::Relaxed);
        assert!(!execute_steps(&steps, &cancel, &sim, |_| {}));
        assert_eq!(
            calls.lock().unwrap().len(),
            1,
            "no new simulate after cancel"
        );
    }
}
