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
        // The settle sleep that ran after the previous simulated event. It's
        // credited against the next inter-event gap so it isn't double-counted
        // into the replay's wall-clock timing (the sleep still runs).
        let mut prev_post_ms: u64 = 0;
        for (index, event) in events.iter().enumerate() {
            let should_update_ui = should_update_position(events, index);
            let mut pos_ms: u64 = 0;
            if should_update_ui {
                steps.push(PlannedStep::EmitPosition { index });
                if speed <= 2.0 {
                    steps.push(PlannedStep::Sleep { ms: 10 });
                    pos_ms = 10;
                }
            }

            // A button replays as move → 10ms settle → press, so its pre-press
            // settle is part of the gap budget too.
            let pre_ms: u64 = if matches!(
                event,
                InputEvent::ButtonPress { .. } | InputEvent::ButtonRelease { .. }
            ) {
                10
            } else {
                0
            };

            // Inter-event sleep. Credit the fixed settle sleeps that bracket this
            // event (previous post, this position update, this pre-press) so the
            // time between simulated events matches the recording exactly — the
            // settle sleeps still run for reliability; only the gap sleep shrinks.
            if index == 0 {
                steps.push(PlannedStep::Sleep { ms: 50 });
            } else {
                let raw_delay = (event.timestamp() - events[index - 1].timestamp()).max(0) as u64;
                let scaled = (raw_delay as f64 / speed) as u64;
                let credit = prev_post_ms + pos_ms + pre_ms;
                let min_delay = min_delay_for(event);
                let actual = scaled.saturating_sub(credit).max(min_delay);
                if actual > 0 {
                    steps.push(PlannedStep::Sleep { ms: actual });
                }
            }

            // Simulation.
            if matches!(event, InputEvent::KeyCombo { .. }) {
                // Annotation only — not simulated, contributes no post settle.
                prev_post_ms = 0;
                continue;
            }
            push_simulate(&mut steps, event);
            // Post-event settle sleep. High-frequency scroll ticks skip it so a
            // burst replays near real-time; discrete events keep the 10ms settle.
            let post_ms = if matches!(event, InputEvent::Scroll { .. }) {
                1
            } else if speed <= 2.0 {
                10
            } else {
                1
            };
            steps.push(PlannedStep::Sleep { ms: post_ms });
            prev_post_ms = post_ms;
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
        Some(InputEvent::MouseMove { .. }) | Some(InputEvent::Scroll { .. }) => {
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
                log::warn!(target: "macroni::playback_plan", "unknown key: {key}");
            }
        }
        InputEvent::KeyRelease { key, .. } => {
            if let Some(k) = string_to_key(key) {
                steps.push(PlannedStep::Simulate(EventType::KeyRelease(k)));
            } else {
                log::warn!(target: "macroni::playback_plan", "unknown key: {key}");
            }
        }
        InputEvent::ButtonPress { button, x, y, .. } => {
            if let Some(b) = string_to_button(button) {
                // Move mouse first, then press — matches the prior behaviour.
                steps.push(PlannedStep::Simulate(EventType::MouseMove { x: *x, y: *y }));
                steps.push(PlannedStep::Sleep { ms: 10 });
                steps.push(PlannedStep::Simulate(EventType::ButtonPress(b)));
            } else {
                log::warn!(target: "macroni::playback_plan", "unknown button: {button}");
            }
        }
        InputEvent::ButtonRelease { button, x, y, .. } => {
            if let Some(b) = string_to_button(button) {
                steps.push(PlannedStep::Simulate(EventType::MouseMove { x: *x, y: *y }));
                steps.push(PlannedStep::Sleep { ms: 10 });
                steps.push(PlannedStep::Simulate(EventType::ButtonRelease(b)));
            } else {
                log::warn!(target: "macroni::playback_plan", "unknown button: {button}");
            }
        }
        InputEvent::MouseMove { x, y, .. } => {
            steps.push(PlannedStep::Simulate(EventType::MouseMove { x: *x, y: *y }));
        }
        InputEvent::Scroll {
            delta_x, delta_y, ..
        } => {
            steps.push(PlannedStep::Simulate(EventType::Wheel {
                delta_x: *delta_x,
                delta_y: *delta_y,
            }));
        }
        InputEvent::KeyCombo { .. } => {}
        InputEvent::SpaceSwitch {
            direction, count, ..
        } => {
            // Replayed as the stock Mission Control shortcut ⌃←/⌃→ (the
            // gesture itself cannot be synthesized). Requires the default
            // "Move left/right a space" shortcuts to be enabled.
            let arrow = if direction == "left" {
                rdev::Key::LeftArrow
            } else {
                rdev::Key::RightArrow
            };
            for hop in 0..(*count).max(1) {
                if hop > 0 {
                    // Let the previous Space transition animation finish.
                    steps.push(PlannedStep::Sleep { ms: 150 });
                }
                steps.push(PlannedStep::Simulate(EventType::KeyPress(
                    rdev::Key::ControlLeft,
                )));
                steps.push(PlannedStep::Sleep { ms: 10 });
                steps.push(PlannedStep::Simulate(EventType::KeyPress(arrow)));
                steps.push(PlannedStep::Sleep { ms: 10 });
                steps.push(PlannedStep::Simulate(EventType::KeyRelease(arrow)));
                steps.push(PlannedStep::Sleep { ms: 10 });
                steps.push(PlannedStep::Simulate(EventType::KeyRelease(
                    rdev::Key::ControlLeft,
                )));
            }
        }
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
    fn scroll(delta_x: i64, delta_y: i64, ts: i64) -> InputEvent {
        InputEvent::Scroll {
            delta_x,
            delta_y,
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
    fn scroll_is_simulated_as_wheel_with_a_short_settle() {
        let events = vec![scroll(2, -5, 0)];
        let plan = PlaybackPlan::compile(&events, 1.0).unwrap();
        assert!(
            plan.steps.iter().any(|s| matches!(
                s,
                PlannedStep::Simulate(EventType::Wheel {
                    delta_x: 2,
                    delta_y: -5
                })
            )),
            "scroll should simulate a Wheel: {:?}",
            plan.steps
        );
        // Scroll uses a 1ms post-event settle (not the 10ms discrete-event one).
        assert!(matches!(
            plan.steps.last(),
            Some(PlannedStep::Sleep { ms: 1 })
        ));
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

    // The tests below were added to close mutation-testing gaps. They assert
    // boundary conditions in the timing logic that the happy-path tests above
    // walk past.

    #[test]
    fn min_delay_for_mouse_move_returns_5_others_return_1() {
        assert_eq!(min_delay_for(&mouse_move(0.0, 0.0, 0)), 5);
        assert_eq!(min_delay_for(&key_press("A", 0)), 1);
        assert_eq!(min_delay_for(&key_release("A", 0)), 1);
        assert_eq!(min_delay_for(&button_press("Left", 0.0, 0.0, 0)), 1);
        assert_eq!(min_delay_for(&key_combo(0)), 1);
    }

    #[test]
    fn sanitize_speed_treats_nan_and_nonpositive_as_invalid_independently() {
        assert_eq!(sanitize_speed(f64::NAN), 1.0);
        assert_eq!(sanitize_speed(0.0), 1.0);
        assert_eq!(sanitize_speed(-1.0), 1.0);
        assert_eq!(sanitize_speed(f64::INFINITY), 1.0);
        // A finite positive speed is preserved (above the 0.01 floor).
        assert_eq!(sanitize_speed(2.5), 2.5);
        // Below 0.01 floor.
        assert_eq!(sanitize_speed(0.001), 0.01);
    }

    #[test]
    fn speed_exactly_2_includes_post_event_10ms_sleep_above_2_drops_to_1ms() {
        // The `speed <= 2.0` branch is the boundary; mutants flipped <= to >.
        let events = vec![key_press("A", 0), key_press("B", 100)];
        let plan_2 = PlaybackPlan::compile(&events, 2.0).unwrap();
        let plan_2_01 = PlaybackPlan::compile(&events, 2.01).unwrap();

        // Post-event sleeps: 10ms at speed<=2, 1ms above.
        let trailing_2 = plan_2.steps.last().cloned();
        let trailing_2_01 = plan_2_01.steps.last().cloned();
        assert!(matches!(trailing_2, Some(PlannedStep::Sleep { ms: 10 })));
        assert!(matches!(trailing_2_01, Some(PlannedStep::Sleep { ms: 1 })));
    }

    #[test]
    fn mouse_move_throttle_uses_strict_greater_than_50ms() {
        // should_update_position uses `> 50` for the "elapsed since last
        // throttle window" check. At exactly 50ms it should NOT update;
        // at 51ms it should.
        let pressed = button_press("Left", 0.0, 0.0, 0);

        // Index 1, delta exactly 50ms — should be throttled (skipped).
        let events_eq = vec![pressed.clone(), mouse_move(1.0, 1.0, 50)];
        let plan_eq = PlaybackPlan::compile(&events_eq, 1.0).unwrap();
        let positions_eq: Vec<usize> = plan_eq
            .steps
            .iter()
            .filter_map(|s| match s {
                PlannedStep::EmitPosition { index } => Some(*index),
                _ => None,
            })
            .collect();
        assert!(
            !positions_eq.contains(&1),
            "delta of exactly 50ms must NOT trigger position emit: {:?}",
            positions_eq
        );

        // Index 1, delta 51ms — must emit.
        let events_gt = vec![pressed, mouse_move(1.0, 1.0, 51)];
        let plan_gt = PlaybackPlan::compile(&events_gt, 1.0).unwrap();
        let positions_gt: Vec<usize> = plan_gt
            .steps
            .iter()
            .filter_map(|s| match s {
                PlannedStep::EmitPosition { index } => Some(*index),
                _ => None,
            })
            .collect();
        assert!(
            positions_gt.contains(&1),
            "delta of 51ms must trigger position emit: {:?}",
            positions_gt
        );
    }

    #[test]
    fn compile_space_switch_emits_ctrl_arrow_sequence_per_hop() {
        use rdev::Key;
        let events = vec![InputEvent::SpaceSwitch {
            direction: "right".into(),
            count: 2,
            timestamp: 0,
        }];
        let plan = PlaybackPlan::compile(&events, 1.0).unwrap();
        let sims: Vec<&EventType> = plan
            .steps
            .iter()
            .filter_map(|s| match s {
                PlannedStep::Simulate(e) => Some(e),
                _ => None,
            })
            .collect();
        let hop = [
            EventType::KeyPress(Key::ControlLeft),
            EventType::KeyPress(Key::RightArrow),
            EventType::KeyRelease(Key::RightArrow),
            EventType::KeyRelease(Key::ControlLeft),
        ];
        assert_eq!(sims.len(), 8, "two hops of 4 key events");
        for (i, sim) in sims.iter().enumerate() {
            assert_eq!(format!("{:?}", *sim), format!("{:?}", hop[i % 4]));
        }
        // An inter-hop pause exists so the Space animation completes.
        assert!(plan
            .steps
            .iter()
            .any(|s| matches!(s, PlannedStep::Sleep { ms: 150 })));
    }

    #[test]
    fn compile_space_switch_left_uses_left_arrow() {
        use rdev::Key;
        let events = vec![InputEvent::SpaceSwitch {
            direction: "left".into(),
            count: 1,
            timestamp: 0,
        }];
        let plan = PlaybackPlan::compile(&events, 1.0).unwrap();
        assert!(plan.steps.iter().any(|s| matches!(
            s,
            PlannedStep::Simulate(EventType::KeyPress(Key::LeftArrow))
        )));
    }

    #[test]
    fn plan_error_display_messages_are_stable() {
        assert_eq!(PlanError::Empty.to_string(), "No events to play");
        assert_eq!(
            PlanError::AllKeyCombos.to_string(),
            "No playable events found"
        );
    }

    #[test]
    fn speed_1x_has_post_position_10ms_sleep_then_inter_event_sleep() {
        // Pins line 62: the `if speed <= 2.0 { push Sleep 10 }` branch must
        // fire at speed 1.0. A mutant that flips <= to > would drop the
        // leading 10ms sleep at slow speeds.
        let events = vec![key_press("A", 0), key_press("B", 100)];
        let plan = PlaybackPlan::compile(&events, 1.0).unwrap();
        // Step 0 must be EmitPosition{0}, step 1 must be Sleep{10}.
        assert!(matches!(
            plan.steps.first(),
            Some(PlannedStep::EmitPosition { index: 0 })
        ));
        assert!(matches!(
            plan.steps.get(1),
            Some(PlannedStep::Sleep { ms: 10 })
        ));
    }

    #[test]
    fn overhead_credit_reduces_inter_event_sleep_at_slow_speed() {
        // The inter-event sleep credits the fixed settle sleeps that bracket the
        // event so the time between simulations matches the recording. For a
        // 100ms gap between two key presses at 1x the credit is the previous
        // event's post settle (10) + this event's position update (10) = 20, so
        // the inter-event Sleep should be exactly 80ms, not 100ms.
        let events = vec![key_press("A", 0), key_press("B", 100)];
        let plan = PlaybackPlan::compile(&events, 1.0).unwrap();
        // Look for an inter-event sleep — the largest Sleep step in the plan
        // that isn't the post-event 10ms or the first-event 50ms.
        let sleeps: Vec<u64> = plan
            .steps
            .iter()
            .filter_map(|s| match s {
                PlannedStep::Sleep { ms } => Some(*ms),
                _ => None,
            })
            .collect();
        assert!(
            sleeps.contains(&80),
            "expected an exact 80ms inter-event sleep (100ms - 20ms settle credit); sleeps were {:?}",
            sleeps
        );
        assert!(
            !sleeps.contains(&100),
            "found a 100ms sleep — settle credit was not applied: {:?}",
            sleeps
        );
    }

    #[test]
    fn inter_event_sleep_credits_button_pre_press_and_prev_post() {
        // A button replays as move → 10ms settle → press, and every event ends
        // with a 10ms post settle. Those fixed sleeps are credited so the gap
        // between two clicks matches the recording: a 200ms gap credits the
        // previous post (10) + position update (10) + pre-press settle (10) = 30,
        // leaving a 170ms inter-event sleep.
        let events = vec![
            button_press("Left", 0.0, 0.0, 0),
            button_press("Left", 0.0, 0.0, 200),
        ];
        let plan = PlaybackPlan::compile(&events, 1.0).unwrap();
        let sleeps: Vec<u64> = plan
            .steps
            .iter()
            .filter_map(|s| match s {
                PlannedStep::Sleep { ms } => Some(*ms),
                _ => None,
            })
            .collect();
        assert!(
            sleeps.contains(&170),
            "expected a 170ms inter-event sleep (200ms - 30ms settle credit); sleeps were {:?}",
            sleeps
        );
    }

    #[test]
    fn throttle_uses_delta_not_sum_of_timestamps() {
        // Pins line 122 `event_time - prev_time`. Picks inputs where the
        // operator matters: delta=5ms (no emit) but sum=55ms (would emit
        // under a + mutant). check_index = max(index-3, 0), so for index 1
        // check_index = 0 — we need events[0].timestamp >= 25 and
        // events[1].timestamp = events[0] + 5.
        let events = vec![
            button_press("Left", 0.0, 0.0, 25), // prev_time = 25
            mouse_move(1.0, 1.0, 30),           // event_time = 30, delta = 5, sum = 55
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
        // Original: delta 5 <= 50, throttled, no emit. Mutant: sum 55 > 50,
        // emits. So position 1 in the list = mutation survived.
        assert!(
            !positions.contains(&1),
            "delta of 5ms must throttle the position emit; the `-` operator \
             keeps it under 50 while a `+` mutant would push sum 55 over 50. \
             positions={:?}",
            positions
        );
    }

    #[test]
    fn inter_event_delay_uses_subtraction_not_addition() {
        // The delay calc is event.timestamp() - prev.timestamp(); a mutant
        // flipped it to +. Two events 100ms apart should produce a sleep
        // around 100ms (minus overhead) — never 200ms.
        let events = vec![key_press("A", 1000), key_press("B", 1100)];
        let plan = PlaybackPlan::compile(&events, 1.0).unwrap();
        let total: u64 = plan
            .steps
            .iter()
            .filter_map(|s| match s {
                PlannedStep::Sleep { ms } => Some(*ms),
                _ => None,
            })
            .sum();
        // A '+' mutation would push total close to 2100ms (1000+1100). The
        // real subtraction stays under 200ms (50 startup + 90 inter-event +
        // 10 post-update + 10 post-simulate × 2). Generous upper bound:
        assert!(
            total < 250,
            "inter-event delay used + instead of -; total sleep {} too large",
            total
        );
    }
}
