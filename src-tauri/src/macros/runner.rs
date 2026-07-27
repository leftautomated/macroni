//! Reactive macro runtime: a watcher loop that polls every enabled rule's
//! trigger each tick and fires the first armed match's action.
//!
//! The core (`run_rules`) is port-driven: it takes a `Simulator` (input),
//! a `WaitProbe` (perception), a `MacroClock` (time), and a `MacroEmitter`
//! (UI events) so the whole state machine can be unit-tested over fakes.
//! `MacroRunner::start` wires the production ports, claims the engine's
//! playback slot, and drives the loop on a worker thread — always releasing
//! the slot on every exit path.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;

use super::{validate_runnable, MacroDoc, MacroError, MacroRule, RuleAction};
use crate::perception::{ObservationResult, Target};
use crate::playback::engine::{execute_steps, sleep_cancellable};
use crate::playback::ports::Simulator;
use crate::playback::{PlaybackEngine, PlaybackPlan};

/// Evaluates whether a rule trigger's perception target is currently satisfied.
/// `&mut` so a live implementation can hold a screen-capture/OCR pipeline.
pub trait WaitProbe: Send + 'static {
    fn evaluate(&mut self, target: &Target) -> Result<bool, String>;
}

/// Pure mapping from an extractor's raw result to a rule trigger's pass/fail
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

/// Time source for the watcher loop's poll interval, injectable so tests can
/// record sleeps instead of blocking on the wall clock.
pub trait MacroClock: Send + 'static {
    /// Cancellable sleep; `false` = cancelled (the run should stop).
    fn sleep_ms(&self, ms: u64, cancel: &AtomicBool) -> bool;
}

/// UI/telemetry sink for run progress. Every run emits exactly one terminal
/// event: `run_finished` on success (Stop rule fired), `run_failed` on any
/// abort (manual stop, probe error, compile error). `index` is the rule's
/// position in `doc.rules` (not its position among only the enabled rules),
/// so a UI can index straight into the saved doc to highlight it.
pub trait MacroEmitter: Send + 'static {
    fn rule_fired(&self, macro_id: &str, rule_id: &str, index: usize);
    fn rule_settled(&self, macro_id: &str, rule_id: &str, index: usize);
    fn run_finished(&self, macro_id: &str, ok: bool);
    fn run_failed(&self, macro_id: &str, rule_id: &str, reason: &str);
}

/// Production clock: wall time + the playback engine's chunked cancellable sleep.
pub struct RealClock;

impl MacroClock for RealClock {
    fn sleep_ms(&self, ms: u64, cancel: &AtomicBool) -> bool {
        sleep_cancellable(ms, cancel)
    }
}

/// Reactive watcher loop. Each tick evaluates enabled rules top-to-bottom
/// (list order = priority) and fires the first ARMED match:
///   - `PlayInputs`: replay the rule's events, then disarm it. It re-arms
///     only after a later tick observes its trigger NOT matching
///     (edge-trigger, so a persistent prompt can't re-fire in a loop).
///   - `Stop`: end the run successfully.
///
/// The run ends via a Stop rule, manual cancel ("stopped"), or a probe /
/// compile error. There are no per-rule timeouts.
pub fn run_rules(
    doc: &MacroDoc,
    cancel: &AtomicBool,
    simulator: &impl Simulator,
    probe: &mut impl WaitProbe,
    clock: &impl MacroClock,
    emitter: &impl MacroEmitter,
) -> Result<(), ()> {
    let macro_id = doc.id.as_str();
    // Pairs each enabled rule with its ORIGINAL position in `doc.rules` —
    // `armed`/`fired`/the loop counter `i` below all index into this
    // filtered vec (that's the cleanest bookkeeping), but every emitted
    // `index` uses the paired `doc_index` so the UI can highlight the right
    // row even when a disabled rule sits earlier in the doc.
    let rules: Vec<(usize, &MacroRule)> = doc
        .rules
        .iter()
        .enumerate()
        .filter(|(_, r)| r.enabled)
        .collect();
    if rules.is_empty() {
        // Pre-validated by MacroRunner::start; still emit one terminal event
        // so a malformed direct call can't end silently.
        emitter.run_failed(macro_id, "", &MacroError::NoEnabledRules.to_string());
        return Err(());
    }
    let mut armed = vec![true; rules.len()];

    loop {
        if !cancel.load(Ordering::Relaxed) {
            emitter.run_failed(macro_id, "", "stopped");
            return Err(());
        }

        // Evaluate top-to-bottom; stop at the first armed match. Rules seen
        // NOT matching re-arm; rules after a fired one keep their state.
        let mut fired: Option<usize> = None;
        for (i, (_, rule)) in rules.iter().enumerate() {
            match probe.evaluate(&rule.trigger) {
                Err(e) => {
                    emitter.run_failed(macro_id, &rule.id, &format!("evaluation-error: {e}"));
                    return Err(());
                }
                Ok(true) => {
                    if armed[i] {
                        fired = Some(i);
                        break;
                    }
                }
                Ok(false) => armed[i] = true,
            }
        }

        if let Some(i) = fired {
            let (doc_index, rule) = rules[i];
            emitter.rule_fired(macro_id, &rule.id, doc_index);
            match &rule.action {
                RuleAction::Stop => {
                    emitter.rule_settled(macro_id, &rule.id, doc_index);
                    emitter.run_finished(macro_id, true);
                    return Ok(());
                }
                RuleAction::PlayInputs { events, speed, .. } => {
                    let plan = match PlaybackPlan::compile(events, *speed) {
                        Ok(plan) => plan,
                        Err(e) => {
                            emitter.run_failed(macro_id, &rule.id, &format!("compile-error: {e}"));
                            return Err(());
                        }
                    };
                    let completed = execute_steps(&plan.steps, cancel, simulator, |_| {});
                    if !completed {
                        emitter.run_failed(macro_id, &rule.id, "stopped");
                        return Err(());
                    }
                    armed[i] = false;
                    emitter.rule_settled(macro_id, &rule.id, doc_index);
                }
            }
        }

        if !clock.sleep_ms(doc.poll_interval_ms.max(100), cancel) {
            emitter.run_failed(macro_id, "", "stopped");
            return Err(());
        }
    }
}

/// Releases the engine slot (flips the shared flag false) on drop, so the
/// slot is freed on every worker exit — including a panic in `run_rules`.
struct ReleaseGuard(Arc<AtomicBool>);

impl Drop for ReleaseGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Relaxed);
    }
}

/// Spawns and drives a macro run. Validates the doc, claims the engine
/// playback slot, then runs the watcher loop on a worker thread — releasing
/// the slot on every exit path.
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
            // panic inside the watcher loop.
            let _release = ReleaseGuard(Arc::clone(&flag));
            let mut probe = probe;
            let _ = run_rules(&doc, &flag, &simulator, &mut probe, &clock, &emitter);
        });

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{
        result_matches, run_rules, MacroClock, MacroEmitter, MacroRunner, RealClock, WaitProbe,
    };
    use crate::macros::{MacroDoc, MacroRule, RuleAction};
    use crate::perception::{Modality, ObservationResult, Region, Target, TargetKind, TextSpan};
    use crate::playback::ports::Simulator;
    use crate::playback::PlaybackEngine;
    use crate::types::InputEvent;

    use rdev::{EventType, Key};
    use std::collections::{HashMap, VecDeque};
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
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

    /// Pops scripted results per `evaluate`, keyed by `target.id` so a
    /// multi-rule doc can script each rule's trigger independently. A target
    /// with no script, or an exhausted one, always evaluates `Ok(false)`.
    /// Records every evaluated target id in order so tests can assert a
    /// disabled/short-circuited rule's target was never even asked about.
    #[derive(Default)]
    struct ScriptedProbe {
        scripts: HashMap<String, VecDeque<Result<bool, String>>>,
        evals: Arc<Mutex<Vec<String>>>,
    }
    impl ScriptedProbe {
        fn new() -> Self {
            Self::default()
        }
        fn script(mut self, target_id: &str, results: Vec<Result<bool, String>>) -> Self {
            self.scripts.insert(target_id.to_string(), results.into());
            self
        }
        fn eval_log(&self) -> Arc<Mutex<Vec<String>>> {
            Arc::clone(&self.evals)
        }
    }
    impl WaitProbe for ScriptedProbe {
        fn evaluate(&mut self, target: &Target) -> Result<bool, String> {
            self.evals.lock().unwrap().push(target.id.clone());
            match self.scripts.get_mut(&target.id) {
                Some(queue) => queue.pop_front().unwrap_or(Ok(false)),
                None => Ok(false),
            }
        }
    }

    /// Virtual clock: `sleep_ms` records the duration and returns the
    /// (possibly just-flipped) cancel flag. If `stop_at` is set, the Nth
    /// sleep flips `cancel` to false to model an engine stop.
    #[derive(Clone)]
    struct FakeClock {
        sleeps: Arc<Mutex<Vec<u64>>>,
        calls: Arc<AtomicUsize>,
        stop_at: Option<usize>,
    }
    impl FakeClock {
        fn new() -> Self {
            Self {
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
        fn sleep_ms(&self, ms: u64, cancel: &AtomicBool) -> bool {
            self.sleeps.lock().unwrap().push(ms);
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
        fn rule_fired(&self, _macro_id: &str, rule_id: &str, index: usize) {
            self.calls
                .lock()
                .unwrap()
                .push(format!("fired:{rule_id}:{index}"));
        }
        fn rule_settled(&self, _macro_id: &str, rule_id: &str, index: usize) {
            self.calls
                .lock()
                .unwrap()
                .push(format!("settled:{rule_id}:{index}"));
        }
        fn run_finished(&self, _macro_id: &str, ok: bool) {
            self.calls
                .lock()
                .unwrap()
                .push(format!("run_finished:{ok}"));
        }
        fn run_failed(&self, _macro_id: &str, rule_id: &str, reason: &str) {
            self.calls
                .lock()
                .unwrap()
                .push(format!("failed:{rule_id}:{reason}"));
        }
    }

    // ---- Doc builders ----------------------------------------------------

    fn trigger(id: &str) -> Target {
        Target {
            id: id.into(),
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

    fn play_rule(id: &str, trigger_id: &str, key: &str) -> MacroRule {
        MacroRule {
            id: id.into(),
            trigger: trigger(trigger_id),
            action: RuleAction::PlayInputs {
                events: vec![InputEvent::KeyPress {
                    key: key.into(),
                    timestamp: 0,
                }],
                speed: 1.0,
                provenance: None,
            },
            enabled: true,
            anchor: None,
        }
    }

    fn stop_rule(id: &str, trigger_id: &str) -> MacroRule {
        MacroRule {
            id: id.into(),
            trigger: trigger(trigger_id),
            action: RuleAction::Stop,
            enabled: true,
            anchor: None,
        }
    }

    fn doc(rules: Vec<MacroRule>) -> MacroDoc {
        MacroDoc {
            id: "m1".into(),
            name: "test".into(),
            rules,
            poll_interval_ms: 250,
            created_at: 1,
        }
    }

    // ---- Tests -----------------------------------------------------------

    #[test]
    fn priority_only_the_first_armed_match_fires() {
        // Two rules; the probe is scripted so both WOULD match, but
        // evaluation stops at the first armed match — rule[1]'s target is
        // never even asked about.
        let d = doc(vec![play_rule("r1", "t1", "A"), play_rule("r2", "t2", "B")]);
        let cancel = AtomicBool::new(true);
        let sim = FakeSimulator::default();
        let mut probe = ScriptedProbe::new()
            .script("t1", vec![Ok(true)])
            .script("t2", vec![Ok(true)]);
        let eval_log = probe.eval_log();
        let clock = FakeClock::stopping_after(1);
        let emitter = RecordingEmitter::default();

        let res = run_rules(&d, &cancel, &sim, &mut probe, &clock, &emitter);
        assert_eq!(res, Err(())); // stopped after tick 1's sleep

        let fired: Vec<String> = emitter
            .log()
            .into_iter()
            .filter(|c| c.starts_with("fired:"))
            .collect();
        // Both rules are enabled, so filtered position == doc.rules position.
        assert_eq!(fired, vec!["fired:r1:0"]);
        assert!(!eval_log.lock().unwrap().contains(&"t2".to_string()));
    }

    #[test]
    fn edge_triggered_rule_rearms_only_after_a_miss() {
        // Script: match, match, miss, match. A persistent match after the
        // first firing must NOT refire — only the miss at tick 3 re-arms the
        // rule for tick 4.
        let d = doc(vec![play_rule("r1", "t1", "A")]);
        let cancel = AtomicBool::new(true);
        let sim = FakeSimulator::default();
        let mut probe =
            ScriptedProbe::new().script("t1", vec![Ok(true), Ok(true), Ok(false), Ok(true)]);
        let clock = FakeClock::stopping_after(4);
        let emitter = RecordingEmitter::default();

        let res = run_rules(&d, &cancel, &sim, &mut probe, &clock, &emitter);
        assert_eq!(res, Err(()));

        let fired = emitter
            .log()
            .iter()
            .filter(|c| c.starts_with("fired:"))
            .count();
        assert_eq!(fired, 2);
    }

    #[test]
    fn persistent_match_never_refires_without_an_intervening_miss() {
        let d = doc(vec![play_rule("r1", "t1", "A")]);
        let cancel = AtomicBool::new(true);
        let sim = FakeSimulator::default();
        let mut probe = ScriptedProbe::new().script("t1", vec![Ok(true), Ok(true), Ok(true)]);
        let clock = FakeClock::stopping_after(3);
        let emitter = RecordingEmitter::default();

        let res = run_rules(&d, &cancel, &sim, &mut probe, &clock, &emitter);
        assert_eq!(res, Err(()));

        let fired = emitter
            .log()
            .iter()
            .filter(|c| c.starts_with("fired:"))
            .count();
        assert_eq!(fired, 1);
    }

    #[test]
    fn disabled_rules_are_skipped_and_never_evaluated() {
        // r1 (index 0) is disabled, r2 (index 1) is enabled and fires. The
        // emitted index must be r2's position in doc.rules (1) — NOT its
        // position among only the enabled rules (0) — so a UI indexing
        // straight into doc.rules highlights r2, not the disabled r1.
        let mut r1 = play_rule("r1", "t1", "A");
        r1.enabled = false;
        let r2 = play_rule("r2", "t2", "B");
        let d = doc(vec![r1, r2]);
        let cancel = AtomicBool::new(true);
        let sim = FakeSimulator::default();
        let mut probe = ScriptedProbe::new()
            .script("t1", vec![Ok(true)])
            .script("t2", vec![Ok(true)]);
        let eval_log = probe.eval_log();
        let clock = FakeClock::stopping_after(1);
        let emitter = RecordingEmitter::default();

        let res = run_rules(&d, &cancel, &sim, &mut probe, &clock, &emitter);
        assert_eq!(res, Err(()));

        let fired: Vec<String> = emitter
            .log()
            .into_iter()
            .filter(|c| c.starts_with("fired:"))
            .collect();
        assert_eq!(fired, vec!["fired:r2:1"]);
        assert!(!eval_log.lock().unwrap().contains(&"t1".to_string()));
    }

    #[test]
    fn stop_rule_ends_the_run_successfully() {
        let d = doc(vec![stop_rule("r1", "t1")]);
        let cancel = AtomicBool::new(true);
        let sim = FakeSimulator::default();
        let mut probe = ScriptedProbe::new().script("t1", vec![Ok(true)]);
        let clock = FakeClock::new();
        let emitter = RecordingEmitter::default();

        let res = run_rules(&d, &cancel, &sim, &mut probe, &clock, &emitter);
        assert_eq!(res, Ok(()));
        assert_eq!(
            emitter.log(),
            vec![
                "fired:r1:0".to_string(),
                "settled:r1:0".to_string(),
                "run_finished:true".to_string(),
            ]
        );
        // No sleep: the Stop rule returns before the poll-interval sleep.
        assert!(clock.sleeps().is_empty());
    }

    #[test]
    fn manual_cancel_during_sleep_reports_stopped() {
        // No rule ever matches, so every tick falls through to the sleep,
        // whose false return models an engine.stop() mid-poll.
        let d = doc(vec![play_rule("r1", "t1", "A")]);
        let cancel = AtomicBool::new(true);
        let sim = FakeSimulator::default();
        let mut probe = ScriptedProbe::new();
        let clock = FakeClock::stopping_after(1);
        let emitter = RecordingEmitter::default();

        let res = run_rules(&d, &cancel, &sim, &mut probe, &clock, &emitter);
        assert_eq!(res, Err(()));
        assert_eq!(emitter.log(), vec!["failed::stopped".to_string()]);
    }

    #[test]
    fn cancel_flag_already_false_at_tick_start_reports_stopped() {
        let d = doc(vec![play_rule("r1", "t1", "A")]);
        let cancel = AtomicBool::new(false);
        let sim = FakeSimulator::default();
        let mut probe = ScriptedProbe::new();
        let clock = FakeClock::new();
        let emitter = RecordingEmitter::default();

        let res = run_rules(&d, &cancel, &sim, &mut probe, &clock, &emitter);
        assert_eq!(res, Err(()));
        assert_eq!(emitter.log(), vec!["failed::stopped".to_string()]);
        // The loop never got as far as evaluating a rule or sleeping.
        assert!(clock.sleeps().is_empty());
    }

    #[test]
    fn probe_error_aborts_with_evaluation_error() {
        let d = doc(vec![play_rule("r1", "t1", "A")]);
        let cancel = AtomicBool::new(true);
        let sim = FakeSimulator::default();
        let mut probe = ScriptedProbe::new().script("t1", vec![Err("boom".into())]);
        let clock = FakeClock::new();
        let emitter = RecordingEmitter::default();

        let res = run_rules(&d, &cancel, &sim, &mut probe, &clock, &emitter);
        assert_eq!(res, Err(()));
        assert_eq!(
            emitter.log(),
            vec!["failed:r1:evaluation-error: boom".to_string()]
        );
    }

    #[test]
    fn empty_enabled_rules_reports_no_enabled_rules() {
        let d = doc(vec![]);
        let cancel = AtomicBool::new(true);
        let sim = FakeSimulator::default();
        let mut probe = ScriptedProbe::new();
        let clock = FakeClock::new();
        let emitter = RecordingEmitter::default();

        let res = run_rules(&d, &cancel, &sim, &mut probe, &clock, &emitter);
        assert_eq!(res, Err(()));
        assert_eq!(
            emitter.log(),
            vec!["failed::Macro has no enabled rules".to_string()]
        );
    }

    #[test]
    fn play_inputs_replays_through_the_simulator_then_disarms() {
        // Match, miss, match: fires twice, each firing replaying the rule's
        // single KeyPress 1:1 through the simulator (compile doesn't
        // synthesize a matching release — it's a straight event translation).
        let d = doc(vec![play_rule("r1", "t1", "A")]);
        let cancel = AtomicBool::new(true);
        let sim = FakeSimulator::default();
        let mut probe = ScriptedProbe::new().script("t1", vec![Ok(true), Ok(false), Ok(true)]);
        let clock = FakeClock::stopping_after(3);
        let emitter = RecordingEmitter::default();

        let res = run_rules(&d, &cancel, &sim, &mut probe, &clock, &emitter);
        assert_eq!(res, Err(()));

        let fired = emitter
            .log()
            .iter()
            .filter(|c| c.starts_with("fired:"))
            .count();
        assert_eq!(fired, 2);
        assert_eq!(
            sim.calls.lock().unwrap().clone(),
            vec![
                EventType::KeyPress(Key::KeyA),
                EventType::KeyPress(Key::KeyA)
            ]
        );
    }

    #[test]
    fn runner_start_rejects_an_invalid_doc_without_claiming_the_slot() {
        let engine = PlaybackEngine::new();
        let result = MacroRunner::start(
            doc(vec![]), // no enabled rules
            &engine,
            FakeSimulator::default(),
            ScriptedProbe::new(),
            RealClock,
            RecordingEmitter::default(),
        );
        assert!(result.is_err());
        assert!(!engine.is_playing());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn runner_start_claims_and_always_releases_engine_slot() {
        // A rule whose trigger never matches (probe always Ok(false)). Uses a
        // RealClock so the watcher genuinely polls in the background; a stop
        // is what releases the slot (there's no per-rule timeout anymore).
        let engine = PlaybackEngine::new();
        let d = doc(vec![play_rule("w", "t1", "A")]);

        MacroRunner::start(
            d,
            &engine,
            FakeSimulator::default(),
            ScriptedProbe::new(), // always Ok(false) -> never fires
            RealClock,
            RecordingEmitter::default(),
        )
        .unwrap();

        // Slot is claimed synchronously before start returns.
        assert!(engine.is_playing());
        std::thread::sleep(Duration::from_millis(50));
        engine.stop();

        let deadline = Instant::now() + Duration::from_secs(2);
        while engine.is_playing() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(!engine.is_playing(), "slot must be released after stop");

        // Slot is reusable: a second run claims it successfully.
        let second = MacroRunner::start(
            doc(vec![play_rule("w2", "t2", "A")]),
            &engine,
            FakeSimulator::default(),
            ScriptedProbe::new(),
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
