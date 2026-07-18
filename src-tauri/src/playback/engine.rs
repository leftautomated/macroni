//! Drives a `PlaybackPlan` against `Simulator` and `Emitter` ports. Owns the
//! playback state machine (`is_playing`, current position, loop count). All
//! timing/throttling decisions live in the plan; the engine just sleeps,
//! emits, simulates, and polls for cancellation.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use super::plan::{PlannedStep, PlaybackPlan};
use super::ports::{Emitter, Simulator};

/// 100ms warmup before the first iteration — gives UI listeners time to wire up.
const WARMUP_MS: u64 = 100;
/// 50ms gap inserted between iterations when looping.
const LOOP_RESTART_GAP_MS: u64 = 50;

pub struct PlaybackEngine {
    active_run: Arc<Mutex<Option<Arc<AtomicBool>>>>,
    position: Arc<Mutex<Option<usize>>>,
    loop_count: Arc<AtomicUsize>,
}

impl PlaybackEngine {
    pub fn new() -> Self {
        Self {
            active_run: Arc::new(Mutex::new(None)),
            position: Arc::new(Mutex::new(None)),
            loop_count: Arc::new(AtomicUsize::new(0)),
        }
    }

    pub fn is_playing(&self) -> bool {
        self.active_run
            .lock()
            .ok()
            .and_then(|active| active.as_ref().map(|run| run.load(Ordering::Relaxed)))
            .unwrap_or(false)
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
        if let Ok(mut active) = self.active_run.lock() {
            if let Some(run) = active.take() {
                run.store(false, Ordering::Relaxed);
            }
        }
        if let Ok(mut p) = self.position.lock() {
            *p = None;
        }
        self.loop_count.store(0, Ordering::Relaxed);
    }

    /// Claim the input-control slot for a background automation run (mutually
    /// exclusive with `start`). Errors if playback or another automation
    /// already holds it.
    /// Each claim receives its own cancellation flag, so a rapid stop/start
    /// cannot revive the worker from the previous run. Release by storing
    /// `false` into the returned flag (or via `stop()`).
    pub(crate) fn claim_input_slot(&self) -> Result<Arc<AtomicBool>, String> {
        let mut active = self
            .active_run
            .lock()
            .map_err(|_| "Input automation state is unavailable".to_string())?;
        if active
            .as_ref()
            .is_some_and(|run| run.load(Ordering::Relaxed))
        {
            return Err("Another input automation is already running".to_string());
        }
        let run = Arc::new(AtomicBool::new(true));
        *active = Some(Arc::clone(&run));
        Ok(run)
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
        let run = self
            .claim_input_slot()
            .map_err(|_| "Already playing".to_string())?;
        if let Ok(mut p) = self.position.lock() {
            *p = None;
        }
        self.loop_count.store(0, Ordering::Relaxed);

        let active_run = Arc::clone(&self.active_run);
        let position = Arc::clone(&self.position);
        let loop_count = Arc::clone(&self.loop_count);

        thread::spawn(move || {
            run_plan(
                plan,
                loop_forever,
                &run,
                &active_run,
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
    run: &Arc<AtomicBool>,
    active_run: &Mutex<Option<Arc<AtomicBool>>>,
    position: &Mutex<Option<usize>>,
    loop_count: &AtomicUsize,
    simulator: impl Simulator,
    emitter: impl Emitter,
) {
    // Hold a macOS "no App Nap" activity assertion for the WHOLE run. When the
    // user focuses their target app, macroni drops to the background; without
    // this, App Nap + timer coalescing stretch every `thread::sleep` in the
    // loop and inflate the replay. Dropped on return. No-op off macOS.
    let _no_nap = crate::power::NoNapGuard::new("Replaying macro");
    // For the post-run timing confirmation log: total planned sleep time vs.
    // wall-clock elapsed. Ratio should sit near 1.0 with the guard held.
    let started = std::time::Instant::now();
    let planned_ms: u64 = plan
        .steps
        .iter()
        .filter_map(|s| match s {
            PlannedStep::Sleep { ms } | PlannedStep::TimelineSleep { ms } => Some(*ms),
            _ => None,
        })
        .sum();

    // Warmup so UI subscribers have a chance to attach.
    if !sleep_cancellable(WARMUP_MS, run) {
        return finalize(emitter, run, active_run, position, loop_count);
    }

    let mut is_first_iteration = true;
    loop {
        if !run.load(Ordering::Relaxed) {
            break;
        }

        if !is_first_iteration {
            loop_count.fetch_add(1, Ordering::Relaxed);
            if let Ok(mut p) = position.lock() {
                *p = Some(0);
            }
            emitter.emit_loop_restart();
            if !sleep_cancellable(LOOP_RESTART_GAP_MS, run) {
                break;
            }
        }
        is_first_iteration = false;

        let completed = execute_steps(&plan.steps, run, &simulator, |i| {
            if let Ok(mut p) = position.lock() {
                *p = Some(i);
            }
            emitter.emit_position(i);
        });

        if !completed || !loop_forever {
            break;
        }
    }

    // Confirmation log: with the no-nap guard held, actualMs should track
    // plannedMs (ratio ~= 1.0). Before the fix, an unfocused run napped and
    // ratio ran well above 1. `.max(1)` guards a zero-sleep plan.
    let actual_ms = started.elapsed().as_millis() as u64;
    crate::observability::log_info(
        "playback",
        "replay_timing",
        Some(serde_json::json!({
            "plannedMs": planned_ms,
            "actualMs": actual_ms,
            "ratio": actual_ms as f64 / planned_ms.max(1) as f64,
        })),
    );

    finalize(emitter, run, active_run, position, loop_count);
}

/// Execute a single iteration's worth of steps against `simulator`,
/// reporting each `EmitPosition` step's index via `on_position` and
/// bailing as soon as `cancel` flips false. Returns whether every step
/// ran to completion (`true`) or the run was cut short by cancellation
/// (`false`).
pub(crate) fn execute_steps(
    steps: &[PlannedStep],
    cancel: &AtomicBool,
    simulator: &impl Simulator,
    mut on_position: impl FnMut(usize),
) -> bool {
    let mut completed = true;
    let iteration_started = Instant::now();
    let mut planned_elapsed_ms = 0_u64;
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
                planned_elapsed_ms = planned_elapsed_ms.saturating_add(*ms);
            }
            PlannedStep::TimelineSleep { ms } => {
                planned_elapsed_ms = planned_elapsed_ms.saturating_add(*ms);
                let remaining = timeline_remaining(planned_elapsed_ms, iteration_started.elapsed());
                if !sleep_cancellable_duration(remaining, cancel) {
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
    run: &Arc<AtomicBool>,
    active_run: &Mutex<Option<Arc<AtomicBool>>>,
    position: &Mutex<Option<usize>>,
    loop_count: &AtomicUsize,
) {
    run.store(false, Ordering::Relaxed);
    let owns_slot = active_run
        .lock()
        .ok()
        .is_some_and(|mut active| match active.as_ref() {
            Some(current) if Arc::ptr_eq(current, run) => {
                *active = None;
                true
            }
            _ => false,
        });
    if !owns_slot {
        return;
    }
    if let Ok(mut p) = position.lock() {
        *p = None;
    }
    loop_count.store(0, Ordering::Relaxed);
    emitter.emit_complete();
}

/// Sleep `ms` in small chunks, bailing if `is_playing` flips to false. Returns
/// `true` if we slept the full duration, `false` if cancelled.
pub(crate) fn sleep_cancellable(ms: u64, is_playing: &AtomicBool) -> bool {
    sleep_cancellable_duration(Duration::from_millis(ms), is_playing)
}

fn timeline_remaining(planned_elapsed_ms: u64, actual_elapsed: Duration) -> Duration {
    Duration::from_millis(planned_elapsed_ms).saturating_sub(actual_elapsed)
}

fn sleep_cancellable_duration(duration: Duration, is_playing: &AtomicBool) -> bool {
    if duration.is_zero() {
        return is_playing.load(Ordering::Relaxed);
    }
    const CHUNK: Duration = Duration::from_millis(10);
    let deadline = Instant::now() + duration;
    loop {
        if !is_playing.load(Ordering::Relaxed) {
            return false;
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return true;
        }
        thread::sleep(remaining.min(CHUNK));
    }
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
    fn timeline_remaining_recovers_prior_execution_overhead() {
        let remaining = timeline_remaining(1_000, Duration::from_millis(275));
        assert_eq!(remaining, Duration::from_millis(725));
    }

    #[test]
    fn timeline_remaining_skips_wait_when_execution_is_already_late() {
        let remaining = timeline_remaining(1_000, Duration::from_millis(1_250));
        assert_eq!(remaining, Duration::ZERO);
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
    fn input_slot_claim_excludes_playback_and_stop_releases() {
        let engine = PlaybackEngine::new();
        let flag = engine.claim_input_slot().unwrap();
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
        assert!(engine.claim_input_slot().is_err());
        // engine.stop() flips this run's flag — the macro runner sees it.
        engine.stop();
        assert!(!flag.load(Ordering::Relaxed));
        // Slot reusable after release.
        assert!(engine.claim_input_slot().is_ok());
        engine.stop();
    }

    #[test]
    fn rapid_restart_does_not_revive_or_let_old_run_cancel_new_run() {
        let engine = PlaybackEngine::new();
        let old_run = engine.claim_input_slot().unwrap();
        engine.stop();
        let new_run = engine.claim_input_slot().unwrap();

        old_run.store(false, Ordering::Relaxed);

        assert!(!old_run.load(Ordering::Relaxed));
        assert!(new_run.load(Ordering::Relaxed));
        assert!(engine.is_playing());
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
