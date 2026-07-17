//! Linear macro runtime: walks a validated `MacroDoc` chain node-by-node,
//! replaying `Segment` recordings through the playback seam and gating on
//! `WaitFor` perception targets via a pollable probe.
//!
//! The core (`run_chain`) is port-driven: it takes a `Simulator` (input),
//! a `WaitProbe` (perception), a `MacroClock` (time), and a `MacroEmitter`
//! (UI events) so the whole state machine can be unit-tested over fakes.
//! `MacroRunner::start` wires the production ports, claims the engine's
//! playback slot, and drives the walk on a worker thread — always releasing
//! the slot on every exit path.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;

use super::{chain_order, validate_runnable, MacroDoc, MacroNodeKind};
use crate::perception::{ObservationResult, Target};
use crate::playback::engine::{execute_steps, sleep_cancellable};
use crate::playback::ports::Simulator;
use crate::playback::{PlaybackEngine, PlaybackPlan};

/// Evaluates whether a wait node's perception target is currently satisfied.
/// `&mut` so a live implementation can hold a screen-capture/OCR pipeline.
pub trait WaitProbe: Send + 'static {
    fn evaluate(&mut self, target: &Target) -> Result<bool, String>;
}

/// Pure mapping from an extractor's raw result to the wait node's pass/fail
/// verdict — shared by the live probe (`probe.rs`) and unit tests here so the
/// matching rules are tested without a screen-capture/OCR dependency.
/// `expect_of_text` is `TargetKind::TextOcr { expect }`'s payload; `None` for
/// every other target kind (Template/Color ignore it and use `matched`).
pub fn result_matches(result: &ObservationResult, expect_of_text: Option<&str>) -> bool {
    match result {
        ObservationResult::Text { spans } => match expect_of_text {
            None => !spans.is_empty(),
            Some(expect) => {
                let expect = expect.to_lowercase();
                spans
                    .iter()
                    .any(|s| s.text.to_lowercase().contains(&expect))
            }
        },
        ObservationResult::Template { matched, .. } => *matched,
        ObservationResult::Color { matched, .. } => *matched,
    }
}

/// Time source for the wait loop, injectable so tests can advance a virtual
/// clock and record sleeps instead of blocking on the wall clock.
pub trait MacroClock: Send + 'static {
    fn now_ms(&self) -> i64;
    /// Cancellable sleep; `false` = cancelled (the run should stop).
    fn sleep_ms(&self, ms: u64, cancel: &AtomicBool) -> bool;
}

/// UI/telemetry sink for run progress. Every run emits exactly one terminal
/// event: `run_finished` on success, `run_failed` on any abort.
pub trait MacroEmitter: Send + 'static {
    fn node_started(&self, macro_id: &str, node_id: &str, index: usize);
    fn node_finished(&self, macro_id: &str, node_id: &str, index: usize);
    fn run_finished(&self, macro_id: &str, ok: bool);
    fn run_failed(&self, macro_id: &str, node_id: &str, reason: &str);
}

/// Production clock: wall time + the playback engine's chunked cancellable sleep.
pub struct RealClock;

impl MacroClock for RealClock {
    fn now_ms(&self) -> i64 {
        chrono::Utc::now().timestamp_millis()
    }
    fn sleep_ms(&self, ms: u64, cancel: &AtomicBool) -> bool {
        sleep_cancellable(ms, cancel)
    }
}

/// Walks `doc`'s chain synchronously on the caller's thread. `cancel` is the
/// claimed engine flag (flips false on stop). Releases NOTHING itself — the
/// caller owns the slot. Returns `Err(())` if the run did not complete; the
/// failure detail is carried to the UI via `emitter.run_failed`.
pub fn run_chain(
    doc: &MacroDoc,
    cancel: &AtomicBool,
    simulator: &impl Simulator,
    probe: &mut impl WaitProbe,
    clock: &impl MacroClock,
    emitter: &impl MacroEmitter,
) -> Result<(), ()> {
    let macro_id = doc.id.as_str();

    // Pre-validated by `MacroRunner::start`; re-resolved here so `run_chain`
    // is self-contained. A malformed doc still emits one terminal failure.
    let order = match chain_order(doc) {
        Ok(order) => order,
        Err(e) => {
            emitter.run_failed(macro_id, "", &format!("chain-error: {e}"));
            return Err(());
        }
    };

    for (index, node) in order.iter().enumerate() {
        let node_id = node.id.as_str();
        emitter.node_started(macro_id, node_id, index);

        match &node.kind {
            MacroNodeKind::Segment { events, speed, .. } => {
                let plan = match PlaybackPlan::compile(events, *speed) {
                    Ok(plan) => plan,
                    Err(e) => {
                        emitter.run_failed(macro_id, node_id, &format!("compile-error: {e}"));
                        return Err(());
                    }
                };
                // Node-level events only in v1: the per-step position callback
                // is a no-op (the graph node is the unit of UI progress).
                let completed = execute_steps(&plan.steps, cancel, simulator, |_| {});
                if !completed {
                    emitter.run_failed(macro_id, node_id, "stopped");
                    return Err(());
                }
            }
            MacroNodeKind::WaitFor {
                target,
                timeout_ms,
                poll_interval_ms,
            } => {
                if let Err(reason) =
                    run_wait(target, *timeout_ms, *poll_interval_ms, cancel, probe, clock)
                {
                    emitter.run_failed(macro_id, node_id, &reason);
                    return Err(());
                }
            }
        }

        emitter.node_finished(macro_id, node_id, index);
    }

    emitter.run_finished(macro_id, true);
    Ok(())
}

/// Polls `probe` until the wait node's target is satisfied, the deadline
/// passes, or the run is cancelled. `Err(reason)` carries the terminal
/// failure reason; the caller emits it. Poll order is fixed:
///   1. cancel check          -> `"stopped"`
///   2. `probe.evaluate`       -> `Err` -> `"evaluation-error: {e}"`; `Ok(true)` done
///   3. elapsed >= timeout     -> `"timeout"`
///   4. `clock.sleep_ms` false -> `"stopped"`
fn run_wait(
    target: &Target,
    timeout_ms: u64,
    poll_interval_ms: u64,
    cancel: &AtomicBool,
    probe: &mut impl WaitProbe,
    clock: &impl MacroClock,
) -> Result<(), String> {
    let start = clock.now_ms();
    loop {
        if !cancel.load(Ordering::Relaxed) {
            return Err("stopped".to_string());
        }
        match probe.evaluate(target) {
            Err(e) => return Err(format!("evaluation-error: {e}")),
            Ok(true) => return Ok(()),
            Ok(false) => {}
        }
        if clock.now_ms() - start >= timeout_ms as i64 {
            return Err("timeout".to_string());
        }
        if !clock.sleep_ms(poll_interval_ms.max(100), cancel) {
            return Err("stopped".to_string());
        }
    }
}

/// Releases the engine slot (flips the shared flag false) on drop, so the
/// slot is freed on every worker exit — including a panic in `run_chain`.
struct ReleaseGuard(Arc<AtomicBool>);

impl Drop for ReleaseGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Relaxed);
    }
}

/// Spawns and drives a macro run. Validates the doc, claims the engine
/// playback slot, then walks the chain on a worker thread — releasing the
/// slot on every exit path.
pub struct MacroRunner;

impl MacroRunner {
    pub fn start(
        doc: MacroDoc,
        engine: &PlaybackEngine,
        simulator: impl Simulator,
        probe: impl WaitProbe,
        clock: impl MacroClock,
        emitter: impl MacroEmitter,
    ) -> Result<(), String> {
        validate_runnable(&doc).map_err(|e| e.to_string())?;
        let flag = engine.claim_input_slot()?;

        thread::spawn(move || {
            // Hold a macOS "no App Nap" activity assertion for the whole macro
            // run so background-thread sleeps in the replayed segments (via
            // execute_steps) and wait polls aren't throttled while macroni is
            // unfocused. Dropped when the closure ends. No-op off macOS.
            let _no_nap = crate::power::NoNapGuard::new("Running macro");
            // Guard releases the engine slot on every exit path, including a
            // panic while walking the chain.
            let _release = ReleaseGuard(Arc::clone(&flag));
            let mut probe = probe;
            let _ = run_chain(&doc, &flag, &simulator, &mut probe, &clock, &emitter);
        });

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{
        result_matches, run_chain, MacroClock, MacroEmitter, MacroRunner, RealClock, WaitProbe,
    };
    use crate::macros::{MacroDoc, MacroEdge, MacroNode, MacroNodeKind};
    use crate::perception::{Modality, ObservationResult, Region, Target, TargetKind, TextSpan};
    use crate::playback::ports::Simulator;
    use crate::playback::PlaybackEngine;
    use crate::types::InputEvent;

    use rdev::{EventType, Key};
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    // ---- result_matches ---------------------------------------------------

    fn span(text: &str) -> TextSpan {
        TextSpan {
            text: text.into(),
            region: Region {
                x: 0.0,
                y: 0.0,
                w: 1.0,
                h: 1.0,
            },
            confidence: 1.0,
        }
    }

    #[test]
    fn text_with_no_expectation_matches_iff_spans_nonempty() {
        let none_expect: Option<&str> = None;
        assert!(!result_matches(
            &ObservationResult::Text { spans: vec![] },
            none_expect
        ));
        assert!(result_matches(
            &ObservationResult::Text {
                spans: vec![span("anything")]
            },
            none_expect
        ));
    }

    #[test]
    fn text_with_expectation_matches_case_insensitive_substring() {
        let result = ObservationResult::Text {
            spans: vec![span("Ready to GO")],
        };
        assert!(result_matches(&result, Some("go")));
        assert!(result_matches(&result, Some("READY")));
    }

    #[test]
    fn text_with_expectation_misses_when_no_span_contains_it() {
        let result = ObservationResult::Text {
            spans: vec![span("Loading...")],
        };
        assert!(!result_matches(&result, Some("done")));
    }

    #[test]
    fn text_with_expectation_and_empty_spans_never_matches() {
        assert!(!result_matches(
            &ObservationResult::Text { spans: vec![] },
            Some("go")
        ));
    }

    #[test]
    fn template_result_matches_its_matched_field() {
        let matched = ObservationResult::Template {
            matched: true,
            location: None,
            score: 0.9,
        };
        let unmatched = ObservationResult::Template {
            matched: false,
            location: None,
            score: 0.1,
        };
        assert!(result_matches(&matched, None));
        assert!(!result_matches(&unmatched, None));
    }

    #[test]
    fn color_result_matches_its_matched_field() {
        let matched = ObservationResult::Color {
            rgb: [1, 2, 3],
            matched: true,
        };
        let unmatched = ObservationResult::Color {
            rgb: [1, 2, 3],
            matched: false,
        };
        assert!(result_matches(&matched, None));
        assert!(!result_matches(&unmatched, None));
    }

    // ---- Fakes -----------------------------------------------------------

    /// Records every simulated OS event in order.
    #[derive(Default, Clone)]
    struct FakeSimulator {
        calls: Arc<Mutex<Vec<EventType>>>,
    }
    impl Simulator for FakeSimulator {
        fn simulate(&self, event_type: EventType) -> Result<(), String> {
            self.calls.lock().unwrap().push(event_type);
            Ok(())
        }
    }

    /// Pops scripted results per `evaluate`; empty queue -> `Ok(false)`.
    /// Counts evaluations so tests can pin poll-loop ordering.
    struct ScriptedProbe {
        results: VecDeque<Result<bool, String>>,
        evals: Arc<AtomicUsize>,
    }
    impl ScriptedProbe {
        fn new(results: Vec<Result<bool, String>>) -> Self {
            Self {
                results: results.into(),
                evals: Arc::new(AtomicUsize::new(0)),
            }
        }
        fn eval_counter(&self) -> Arc<AtomicUsize> {
            Arc::clone(&self.evals)
        }
    }
    impl WaitProbe for ScriptedProbe {
        fn evaluate(&mut self, _target: &Target) -> Result<bool, String> {
            self.evals.fetch_add(1, Ordering::Relaxed);
            self.results.pop_front().unwrap_or(Ok(false))
        }
    }

    /// Virtual clock: `sleep_ms` records the duration, advances `now` by it,
    /// and returns the (possibly just-flipped) cancel flag. If `stop_at` is
    /// set, the Nth sleep flips `cancel` to false to model an engine stop.
    #[derive(Clone)]
    struct FakeClock {
        now: Arc<AtomicI64>,
        sleeps: Arc<Mutex<Vec<u64>>>,
        calls: Arc<AtomicUsize>,
        stop_at: Option<usize>,
    }
    impl FakeClock {
        fn new() -> Self {
            Self {
                now: Arc::new(AtomicI64::new(0)),
                sleeps: Arc::new(Mutex::new(Vec::new())),
                calls: Arc::new(AtomicUsize::new(0)),
                stop_at: None,
            }
        }
        fn stopping_after(n: usize) -> Self {
            let mut c = Self::new();
            c.stop_at = Some(n);
            c
        }
        fn sleeps(&self) -> Vec<u64> {
            self.sleeps.lock().unwrap().clone()
        }
    }
    impl MacroClock for FakeClock {
        fn now_ms(&self) -> i64 {
            self.now.load(Ordering::Relaxed)
        }
        fn sleep_ms(&self, ms: u64, cancel: &AtomicBool) -> bool {
            self.sleeps.lock().unwrap().push(ms);
            self.now.fetch_add(ms as i64, Ordering::Relaxed);
            let call = self.calls.fetch_add(1, Ordering::Relaxed) + 1;
            if self.stop_at == Some(call) {
                cancel.store(false, Ordering::Relaxed);
            }
            cancel.load(Ordering::Relaxed)
        }
    }

    /// Records emitter calls as stable strings for exact sequence assertions.
    #[derive(Default, Clone)]
    struct RecordingEmitter {
        calls: Arc<Mutex<Vec<String>>>,
    }
    impl RecordingEmitter {
        fn log(&self) -> Vec<String> {
            self.calls.lock().unwrap().clone()
        }
    }
    impl MacroEmitter for RecordingEmitter {
        fn node_started(&self, _macro_id: &str, node_id: &str, _index: usize) {
            self.calls
                .lock()
                .unwrap()
                .push(format!("started:{node_id}"));
        }
        fn node_finished(&self, _macro_id: &str, node_id: &str, _index: usize) {
            self.calls
                .lock()
                .unwrap()
                .push(format!("finished:{node_id}"));
        }
        fn run_finished(&self, _macro_id: &str, ok: bool) {
            self.calls
                .lock()
                .unwrap()
                .push(format!("run_finished:{ok}"));
        }
        fn run_failed(&self, _macro_id: &str, node_id: &str, reason: &str) {
            self.calls
                .lock()
                .unwrap()
                .push(format!("failed:{node_id}:{reason}"));
        }
    }

    // ---- Doc builders ----------------------------------------------------

    fn target() -> Target {
        Target {
            id: "t1".into(),
            name: "target".into(),
            modality: Modality::Visual,
            region: Some(Region {
                x: 0.1,
                y: 0.1,
                w: 0.2,
                h: 0.2,
            }),
            kind: TargetKind::TextOcr {
                expect: Some("Go".into()),
            },
            created_at: 1,
        }
    }

    fn seg(id: &str, key: &str) -> MacroNode {
        MacroNode {
            id: id.into(),
            kind: MacroNodeKind::Segment {
                events: vec![InputEvent::KeyPress {
                    key: key.into(),
                    timestamp: 0,
                }],
                speed: 1.0,
                provenance: None,
            },
            x: 0.0,
            y: 0.0,
        }
    }

    fn wait(id: &str, timeout_ms: u64, poll_interval_ms: u64) -> MacroNode {
        MacroNode {
            id: id.into(),
            kind: MacroNodeKind::WaitFor {
                target: target(),
                timeout_ms,
                poll_interval_ms,
            },
            x: 0.0,
            y: 0.0,
        }
    }

    fn edge(from: &str, to: &str) -> MacroEdge {
        MacroEdge {
            from: from.into(),
            to: to.into(),
        }
    }

    fn doc(nodes: Vec<MacroNode>, edges: Vec<MacroEdge>) -> MacroDoc {
        MacroDoc {
            id: "m1".into(),
            name: "test".into(),
            nodes,
            edges,
            created_at: 1,
        }
    }

    // ---- Tests -----------------------------------------------------------

    #[test]
    fn happy_path_runs_segment_wait_segment_in_order() {
        // Chain: segment(A) -> wait -> segment(B). The wait matches on the
        // 3rd evaluate, so two 500ms polls elapse first.
        let d = doc(
            vec![seg("n1", "A"), wait("n2", 100_000, 500), seg("n3", "B")],
            vec![edge("n1", "n2"), edge("n2", "n3")],
        );
        let cancel = AtomicBool::new(true);
        let sim = FakeSimulator::default();
        let mut probe = ScriptedProbe::new(vec![Ok(false), Ok(false), Ok(true)]);
        let clock = FakeClock::new();
        let emitter = RecordingEmitter::default();

        let res = run_chain(&d, &cancel, &sim, &mut probe, &clock, &emitter);
        assert_eq!(res, Ok(()));

        // Exact emitter sequence: node pairs in order, wait bracketed, then
        // a single terminal run_finished(ok=true).
        assert_eq!(
            emitter.log(),
            vec![
                "started:n1".to_string(),
                "finished:n1".to_string(),
                "started:n2".to_string(),
                "finished:n2".to_string(),
                "started:n3".to_string(),
                "finished:n3".to_string(),
                "run_finished:true".to_string(),
            ]
        );

        // Both segments simulated their key event, in chain order.
        assert_eq!(
            sim.calls.lock().unwrap().clone(),
            vec![
                EventType::KeyPress(Key::KeyA),
                EventType::KeyPress(Key::KeyB),
            ]
        );

        // Two polls of 500ms elapsed before the wait matched.
        assert_eq!(clock.sleeps(), vec![500, 500]);
    }

    #[test]
    fn timeout_aborts_run_and_skips_remaining_nodes() {
        // wait(timeout 1000, poll 500) then a segment. Probe never matches, so
        // the wait times out after two polls and the segment never runs.
        let d = doc(
            vec![wait("n_wait", 1000, 500), seg("n_seg", "A")],
            vec![edge("n_wait", "n_seg")],
        );
        let cancel = AtomicBool::new(true);
        let sim = FakeSimulator::default();
        let mut probe = ScriptedProbe::new(vec![]); // always Ok(false)
        let evals = probe.eval_counter();
        let clock = FakeClock::new();
        let emitter = RecordingEmitter::default();

        let res = run_chain(&d, &cancel, &sim, &mut probe, &clock, &emitter);
        assert_eq!(res, Err(()));

        // evaluate ran at t=0 (no match); timeout tripped after two 500ms polls.
        assert_eq!(clock.sleeps(), vec![500, 500]);
        // Three evaluations (t=0, t=500, t=1000): the probe is polled at the
        // timeout instant *before* the deadline check fires — proving evaluate
        // precedes the timeout check in the poll order.
        assert_eq!(evals.load(Ordering::Relaxed), 3);
        assert_eq!(
            emitter.log(),
            vec![
                "started:n_wait".to_string(),
                "failed:n_wait:timeout".to_string(),
            ]
        );
        // Following segment was never entered.
        assert_eq!(sim.calls.lock().unwrap().len(), 0);
        // No terminal success event.
        assert!(!emitter.log().iter().any(|c| c.starts_with("run_finished")));
    }

    #[test]
    fn stop_during_wait_reports_stopped() {
        // The first sleep flips cancel=false (models engine.stop mid-wait);
        // the wait loop's sleep-returns-false branch reports "stopped".
        let d = doc(vec![wait("w", 100_000, 500)], vec![]);
        let cancel = AtomicBool::new(true);
        let sim = FakeSimulator::default();
        let mut probe = ScriptedProbe::new(vec![]); // Ok(false) -> proceeds to sleep
        let clock = FakeClock::stopping_after(1);
        let emitter = RecordingEmitter::default();

        let res = run_chain(&d, &cancel, &sim, &mut probe, &clock, &emitter);
        assert_eq!(res, Err(()));
        assert_eq!(clock.sleeps(), vec![500]);
        assert_eq!(
            emitter.log(),
            vec!["started:w".to_string(), "failed:w:stopped".to_string()]
        );
    }

    #[test]
    fn probe_error_aborts_with_evaluation_error() {
        // A probe error aborts immediately with the wrapped reason; no sleep.
        let d = doc(vec![wait("w", 100_000, 500)], vec![]);
        let cancel = AtomicBool::new(true);
        let sim = FakeSimulator::default();
        let mut probe = ScriptedProbe::new(vec![Err("boom".into())]);
        let clock = FakeClock::new();
        let emitter = RecordingEmitter::default();

        let res = run_chain(&d, &cancel, &sim, &mut probe, &clock, &emitter);
        assert_eq!(res, Err(()));
        assert!(clock.sleeps().is_empty());
        assert_eq!(
            emitter.log(),
            vec![
                "started:w".to_string(),
                "failed:w:evaluation-error: boom".to_string(),
            ]
        );
    }

    #[test]
    fn immediate_match_needs_no_sleep() {
        // Probe matches on the first evaluate -> the node finishes before any
        // sleep, proving evaluate precedes the poll sleep.
        let d = doc(vec![wait("w", 100_000, 500)], vec![]);
        let cancel = AtomicBool::new(true);
        let sim = FakeSimulator::default();
        let mut probe = ScriptedProbe::new(vec![Ok(true)]);
        let clock = FakeClock::new();
        let emitter = RecordingEmitter::default();

        let res = run_chain(&d, &cancel, &sim, &mut probe, &clock, &emitter);
        assert_eq!(res, Ok(()));
        assert!(clock.sleeps().is_empty());
        assert_eq!(
            emitter.log(),
            vec![
                "started:w".to_string(),
                "finished:w".to_string(),
                "run_finished:true".to_string(),
            ]
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn runner_start_claims_and_always_releases_engine_slot() {
        // A doc whose wait times out. Uses a RealClock so the run holds the
        // slot for a real (short) window, then releases it on timeout.
        let engine = PlaybackEngine::new();
        let d = doc(vec![wait("w", 200, 100)], vec![]);

        MacroRunner::start(
            d,
            &engine,
            FakeSimulator::default(),
            ScriptedProbe::new(vec![]), // always Ok(false) -> times out
            RealClock,
            RecordingEmitter::default(),
        )
        .unwrap();

        // Slot is claimed synchronously before start returns.
        assert!(engine.is_playing());

        // The worker releases the slot when the wait times out (<= ~2s).
        let deadline = Instant::now() + Duration::from_secs(2);
        while engine.is_playing() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(!engine.is_playing(), "slot must be released after timeout");

        // Slot is reusable: a second run claims it successfully.
        let second = MacroRunner::start(
            doc(vec![wait("w2", 200, 100)], vec![]),
            &engine,
            FakeSimulator::default(),
            ScriptedProbe::new(vec![]),
            RealClock,
            RecordingEmitter::default(),
        );
        assert!(second.is_ok());
        engine.stop();
        let deadline = Instant::now() + Duration::from_secs(2);
        while engine.is_playing() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}
