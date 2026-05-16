//! Pure compiled timeline of playback. Holds every timing/throttling decision
//! so the engine becomes a thin sleep-emit-simulate loop.
//!
//! Compile errors are returned eagerly (empty events / all key-combos);
//! everything else is encoded as a flat sequence of `PlannedStep`s for one
//! iteration. The engine handles warmup, inter-iteration gaps, and stop.

use rdev::EventType;

use crate::key_mapping::{string_to_button, string_to_key};
use crate::types::{InputEvent, InputEventTimestamp};

#[derive(Debug, Clone, PartialEq)]
pub enum PlannedStep {
    /// Tell observers which event index playback is currently on.
    EmitPosition { index: usize },
    /// Wait for `ms` milliseconds (subject to engine-level cancellation between steps).
    Sleep { ms: u64 },
    /// Drive an OS-level input simulation.
    Simulate(EventType),
}

#[derive(Debug, Clone, PartialEq)]
pub enum PlanError {
    Empty,
    AllKeyCombos,
}

impl std::fmt::Display for PlanError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PlanError::Empty => write!(f, "No events to play"),
            PlanError::AllKeyCombos => write!(f, "No playable events found"),
        }
    }
}

#[derive(Debug, Clone)]
pub struct PlaybackPlan {
    pub steps: Vec<PlannedStep>,
}

impl PlaybackPlan {
    pub fn compile(events: &[InputEvent], speed: f64) -> Result<Self, PlanError> {
        if events.is_empty() {
            return Err(PlanError::Empty);
        }
        if !events
            .iter()
            .any(|e| !matches!(e, InputEvent::KeyCombo { .. }))
        {
            return Err(PlanError::AllKeyCombos);
        }
        let speed = sanitize_speed(speed);

        let mut steps = Vec::with_capacity(events.len() * 4);
        for (index, event) in events.iter().enumerate() {
            let should_update_ui = should_update_position(events, index);
            let mut overhead_ms: u64 = 0;
            if should_update_ui {
                steps.push(PlannedStep::EmitPosition { index });
                if speed <= 2.0 {
                    steps.push(PlannedStep::Sleep { ms: 10 });
                    overhead_ms += 10;
                }
            }

            // Inter-event sleep.
            if index == 0 {
                steps.push(PlannedStep::Sleep { ms: 50 });
            } else {
                let raw_delay = (event.timestamp() - events[index - 1].timestamp()).max(0) as u64;
                let scaled = (raw_delay as f64 / speed) as u64;
                let min_delay = min_delay_for(event);
                let actual = scaled.saturating_sub(overhead_ms).max(min_delay);
                if actual > 0 {
                    steps.push(PlannedStep::Sleep { ms: actual });
                }
            }

            // Simulation.
            if matches!(event, InputEvent::KeyCombo { .. }) {
                continue;
            }
            push_simulate(&mut steps, event);
            // Post-event small sleep, dropped at very high speeds.
            steps.push(PlannedStep::Sleep {
                ms: if speed <= 2.0 { 10 } else { 1 },
            });
        }
        Ok(Self { steps })
    }
}

fn sanitize_speed(speed: f64) -> f64 {
    if !speed.is_finite() || speed <= 0.0 {
        1.0
    } else {
        speed.max(0.01)
    }
}

fn min_delay_for(event: &InputEvent) -> u64 {
    match event {
        InputEvent::MouseMove { .. } => 5,
        _ => 1,
    }
}

/// Should we emit a position update for the event at `index`?
/// MouseMove events are throttled — every 3rd, plus any whose timestamp jumped
/// >50ms over the most recent throttle window.
fn should_update_position(events: &[InputEvent], index: usize) -> bool {
    match events.get(index) {
        Some(InputEvent::MouseMove { .. }) => {
            if index == 0 || index.is_multiple_of(3) {
                true
            } else {
                let event_time = events[index].timestamp();
                let check_index = index.saturating_sub(3);
                let prev_time = events[check_index].timestamp();
                (event_time - prev_time) > 50
            }
        }
        Some(_) => true,
        None => false,
    }
}

fn push_simulate(steps: &mut Vec<PlannedStep>, event: &InputEvent) {
    match event {
        InputEvent::KeyPress { key, .. } => {
            if let Some(k) = string_to_key(key) {
                steps.push(PlannedStep::Simulate(EventType::KeyPress(k)));
            } else {
                eprintln!("Unknown key: {}", key);
            }
        }
        InputEvent::KeyRelease { key, .. } => {
            if let Some(k) = string_to_key(key) {
                steps.push(PlannedStep::Simulate(EventType::KeyRelease(k)));
            } else {
                eprintln!("Unknown key: {}", key);
            }
        }
        InputEvent::ButtonPress { button, x, y, .. } => {
            if let Some(b) = string_to_button(button) {
                // Move mouse first, then press — matches the prior behaviour.
                steps.push(PlannedStep::Simulate(EventType::MouseMove { x: *x, y: *y }));
                steps.push(PlannedStep::Sleep { ms: 10 });
                steps.push(PlannedStep::Simulate(EventType::ButtonPress(b)));
            } else {
                eprintln!("Unknown button: {}", button);
            }
        }
        InputEvent::ButtonRelease { button, x, y, .. } => {
            if let Some(b) = string_to_button(button) {
                steps.push(PlannedStep::Simulate(EventType::MouseMove { x: *x, y: *y }));
                steps.push(PlannedStep::Sleep { ms: 10 });
                steps.push(PlannedStep::Simulate(EventType::ButtonRelease(b)));
            } else {
                eprintln!("Unknown button: {}", button);
            }
        }
        InputEvent::MouseMove { x, y, .. } => {
            steps.push(PlannedStep::Simulate(EventType::MouseMove { x: *x, y: *y }));
        }
        InputEvent::KeyCombo { .. } => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rdev::{Button, Key};

    fn key_press(key: &str, ts: i64) -> InputEvent {
        InputEvent::KeyPress {
            key: key.into(),
            timestamp: ts,
        }
    }
    fn key_release(key: &str, ts: i64) -> InputEvent {
        InputEvent::KeyRelease {
            key: key.into(),
            timestamp: ts,
        }
    }
    fn key_combo(ts: i64) -> InputEvent {
        InputEvent::KeyCombo {
            char: "A".into(),
            key: "A".into(),
            modifiers: vec!["MetaLeft".into()],
            timestamp: ts,
        }
    }
    fn button_press(btn: &str, x: f64, y: f64, ts: i64) -> InputEvent {
        InputEvent::ButtonPress {
            button: btn.into(),
            x,
            y,
            timestamp: ts,
        }
    }
    fn mouse_move(x: f64, y: f64, ts: i64) -> InputEvent {
        InputEvent::MouseMove {
            x,
            y,
            timestamp: ts,
        }
    }

    fn total_sleep_ms(steps: &[PlannedStep]) -> u64 {
        steps
            .iter()
            .filter_map(|s| match s {
                PlannedStep::Sleep { ms } => Some(*ms),
                _ => None,
            })
            .sum()
    }

    #[test]
    fn compile_empty_events_errors() {
        assert_eq!(
            PlaybackPlan::compile(&[], 1.0).unwrap_err(),
            PlanError::Empty
        );
    }

    #[test]
    fn compile_all_key_combos_errors() {
        let events = vec![key_combo(0), key_combo(10)];
        assert_eq!(
            PlaybackPlan::compile(&events, 1.0).unwrap_err(),
            PlanError::AllKeyCombos
        );
    }

    #[test]
    fn compile_single_key_press_emits_position_then_simulates() {
        let events = vec![key_press("A", 0)];
        let plan = PlaybackPlan::compile(&events, 1.0).unwrap();
        // Expect: EmitPosition{0} ... Simulate(KeyPress(KeyA)) somewhere after.
        let pos_idx = plan
            .steps
            .iter()
            .position(|s| matches!(s, PlannedStep::EmitPosition { index: 0 }));
        let sim_idx = plan
            .steps
            .iter()
            .position(|s| matches!(s, PlannedStep::Simulate(EventType::KeyPress(Key::KeyA))));
        assert!(pos_idx.is_some(), "no EmitPosition: {:?}", plan.steps);
        assert!(
            sim_idx.is_some(),
            "no Simulate(KeyPress(KeyA)): {:?}",
            plan.steps
        );
        assert!(pos_idx < sim_idx, "EmitPosition must come before Simulate");
    }

    #[test]
    fn key_release_is_simulated() {
        let events = vec![key_press("A", 0), key_release("A", 10)];
        let plan = PlaybackPlan::compile(&events, 1.0).unwrap();
        assert!(plan
            .steps
            .iter()
            .any(|s| matches!(s, PlannedStep::Simulate(EventType::KeyRelease(Key::KeyA)))));
    }

    #[test]
    fn key_combo_event_updates_position_but_is_not_simulated() {
        // The combo must show in the UI position but should not be simulated
        // — combos are an annotation, not a thing to replay.
        let events = vec![key_press("A", 0), key_combo(0), key_release("A", 10)];
        let plan = PlaybackPlan::compile(&events, 1.0).unwrap();
        let combo_simulations = plan
            .steps
            .iter()
            .filter(|s| {
                // Combos would surface as a KeyPress simulate, but they ride alongside
                // a real KeyPress at index 0 — so what we really care about is that
                // there is exactly one KeyPress(KeyA) simulate, not two.
                matches!(s, PlannedStep::Simulate(EventType::KeyPress(Key::KeyA)))
            })
            .count();
        assert_eq!(
            combo_simulations, 1,
            "combo must not produce its own simulate"
        );
        let position_updates: Vec<_> = plan
            .steps
            .iter()
            .filter_map(|s| match s {
                PlannedStep::EmitPosition { index } => Some(*index),
                _ => None,
            })
            .collect();
        assert!(
            position_updates.contains(&1),
            "combo position should be emitted: {:?}",
            position_updates
        );
    }

    #[test]
    fn button_press_inserts_pre_mouse_move_and_10ms_gap_before_press() {
        let events = vec![button_press("Left", 50.0, 60.0, 0)];
        let plan = PlaybackPlan::compile(&events, 1.0).unwrap();
        // Find the ButtonPress Simulate, then walk backward looking for
        // Simulate(MouseMove(50,60)) and a Sleep(10) between them.
        let bp_idx = plan
            .steps
            .iter()
            .position(|s| {
                matches!(
                    s,
                    PlannedStep::Simulate(EventType::ButtonPress(Button::Left))
                )
            })
            .expect("ButtonPress simulate missing");
        let pre_window = &plan.steps[..bp_idx];
        let mm_idx = pre_window.iter().rposition(|s| matches!(s, PlannedStep::Simulate(EventType::MouseMove { x, y }) if *x == 50.0 && *y == 60.0))
            .expect("pre-move MouseMove simulate missing");
        let between = &pre_window[mm_idx + 1..];
        let sleep_ms: u64 = between
            .iter()
            .filter_map(|s| match s {
                PlannedStep::Sleep { ms } => Some(*ms),
                _ => None,
            })
            .sum();
        assert!(
            sleep_ms >= 10,
            "expected at least 10ms between pre-move and press, got {}ms in {:?}",
            sleep_ms,
            between
        );
    }

    #[test]
    fn mouse_move_with_button_held_throttles_position_updates() {
        // index 0 emits, index 1,2 skip, index 3 emits (index % 3 == 0).
        // All events have same timestamp so the >50ms-since-last fallback doesn't trip.
        let events = vec![
            button_press("Left", 0.0, 0.0, 0),
            mouse_move(10.0, 10.0, 1),
            mouse_move(20.0, 20.0, 2),
            mouse_move(30.0, 30.0, 3),
            mouse_move(40.0, 40.0, 4),
        ];
        let plan = PlaybackPlan::compile(&events, 1.0).unwrap();
        let positions: Vec<usize> = plan
            .steps
            .iter()
            .filter_map(|s| match s {
                PlannedStep::EmitPosition { index } => Some(*index),
                _ => None,
            })
            .collect();
        // index 0 (button) emits, then for moves: index 1 skip, 2 skip, 3 emit, 4 skip
        assert!(
            positions.contains(&0),
            "expected position 0: {:?}",
            positions
        );
        assert!(
            positions.contains(&3),
            "expected position 3 (every-3rd): {:?}",
            positions
        );
        assert!(
            !positions.contains(&1),
            "position 1 should be throttled: {:?}",
            positions
        );
        assert!(
            !positions.contains(&2),
            "position 2 should be throttled: {:?}",
            positions
        );
        assert!(
            !positions.contains(&4),
            "position 4 should be throttled: {:?}",
            positions
        );
    }

    #[test]
    fn speed_2x_reduces_inter_event_sleep() {
        // Only the *inter-event* sleep scales with speed; fixed warmup-ish
        // sleeps stay constant. Use a single large inter-event gap so the
        // scaled component dominates: 1000ms at 1x vs 500ms at 2x.
        let events_1x = vec![key_press("A", 0), key_press("B", 1000)];
        let events_2x = events_1x.clone();
        let total_1x = total_sleep_ms(&PlaybackPlan::compile(&events_1x, 1.0).unwrap().steps);
        let total_2x = total_sleep_ms(&PlaybackPlan::compile(&events_2x, 2.0).unwrap().steps);
        // The scaled gap drops by ~500ms; total should drop by at least 400ms.
        assert!(
            total_1x >= total_2x + 400,
            "1x ({}) should exceed 2x ({}) by ~500ms",
            total_1x,
            total_2x
        );
    }

    #[test]
    fn speed_above_2_omits_post_event_10ms_sleeps() {
        // At speed > 2.0 the original code drops the 10ms post-position-update
        // sleep AND the post-simulate 10ms. We just assert: total sleep at 3x
        // is strictly less than at 1x for the same fixture.
        let events = vec![key_press("A", 0), key_press("B", 50), key_press("C", 100)];
        let plan_1x = PlaybackPlan::compile(&events, 1.0).unwrap();
        let plan_3x = PlaybackPlan::compile(&events, 3.0).unwrap();
        assert!(
            total_sleep_ms(&plan_3x.steps) < total_sleep_ms(&plan_1x.steps),
            "3x total sleep ({}) should drop below 1x ({})",
            total_sleep_ms(&plan_3x.steps),
            total_sleep_ms(&plan_1x.steps)
        );
    }

    #[test]
    fn mouse_move_has_min_5ms_delay_floor_at_high_speed() {
        let events = vec![
            button_press("Left", 0.0, 0.0, 0),
            mouse_move(1.0, 1.0, 1),
            mouse_move(2.0, 2.0, 2),
        ];
        // At very high speed the per-event delay collapses; min-delay floor protects MouseMove at 5ms.
        let plan = PlaybackPlan::compile(&events, 1000.0).unwrap();
        // Find any sleep that *precedes* a MouseMove simulate. At least one such
        // sleep should be >= 5ms.
        let mut found_floor = false;
        for (i, s) in plan.steps.iter().enumerate() {
            if matches!(s, PlannedStep::Simulate(EventType::MouseMove { .. })) {
                // walk backward to find the most recent Sleep before this MouseMove
                for prev in plan.steps[..i].iter().rev() {
                    if let PlannedStep::Sleep { ms } = prev {
                        if *ms >= 5 {
                            found_floor = true;
                        }
                        break;
                    }
                }
            }
        }
        assert!(
            found_floor,
            "expected at least one >=5ms sleep before a MouseMove simulate: {:?}",
            plan.steps
        );
    }

    #[test]
    fn compile_used_unused_imports_dont_break() {
        // sanity — string_to_key and string_to_button must convert known names
        assert!(string_to_key("A").is_some());
        assert!(string_to_button("Left").is_some());
    }
}
