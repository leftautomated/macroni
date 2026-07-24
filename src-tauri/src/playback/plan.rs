//! Pure compiled timeline of playback. Holds every timing/throttling decision
//! so the engine becomes a thin sleep-emit-simulate loop.
//!
//! Compile errors are returned eagerly (empty events / all key-combos);
//! everything else is encoded as a flat sequence of `PlannedStep`s for one
//! iteration. The engine handles warmup, inter-iteration gaps, and stop.

use std::borrow::Cow;

use rdev::EventType;

use crate::key_mapping::{string_to_button, string_to_key};
use crate::types::{InputEvent, InputEventTimestamp};

const CURSOR_SAMPLE_INTERVAL_MS: i64 = 8;
const CURSOR_UI_INTERVAL_MS: i64 = 33;
const LEGACY_CURSOR_MIN_DURATION_MS: i64 = 48;
const LEGACY_CURSOR_MAX_DURATION_MS: i64 = 240;
const LEGACY_CURSOR_PIXELS_PER_MS: f64 = 2.0;

struct PreparedEvent<'a> {
    event: Cow<'a, InputEvent>,
    source_index: Option<usize>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum PlannedStep {
    /// Tell observers which event index playback is currently on.
    EmitPosition { index: usize },
    /// A reliability settle that must run for its full relative duration.
    Sleep { ms: u64 },
    /// Advance the recorded timeline by `ms`, then wait only until that
    /// absolute per-iteration deadline. Runtime overhead is therefore
    /// recovered here instead of accumulating between replayed events.
    TimelineSleep { ms: u64 },
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
        let prepared = prepare_events(events);

        let mut steps = Vec::with_capacity(prepared.len() * 3);
        // The settle sleep that ran after the previous simulated event. It's
        // credited against the next inter-event gap so it isn't double-counted
        // into the replay's wall-clock timing (the sleep still runs).
        let mut prev_post_ms: u64 = 0;
        let mut last_cursor_ui_timestamp = None;
        for (prepared_index, prepared_event) in prepared.iter().enumerate() {
            let event = prepared_event.event.as_ref();
            if let Some(index) = prepared_event.source_index {
                let should_update_ui = match event {
                    InputEvent::MouseMove { timestamp, .. }
                    | InputEvent::Scroll { timestamp, .. } => {
                        let should_emit = last_cursor_ui_timestamp.is_none_or(|last| {
                            timestamp.saturating_sub(last) >= CURSOR_UI_INTERVAL_MS
                        });
                        if should_emit {
                            last_cursor_ui_timestamp = Some(*timestamp);
                        }
                        should_emit
                    }
                    _ => true,
                };
                if should_update_ui {
                    steps.push(PlannedStep::EmitPosition { index });
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
            // event (previous post and this pre-press) so the
            // time between simulated events matches the recording exactly — the
            // settle sleeps still run for reliability; only the gap sleep shrinks.
            if prepared_index == 0 {
                steps.push(PlannedStep::Sleep { ms: 50 });
            } else {
                let raw_delay = (event.timestamp() - prepared[prepared_index - 1].event.timestamp())
                    .max(0) as u64;
                let scaled = (raw_delay as f64 / speed) as u64;
                let credit = prev_post_ms + pre_ms;
                let min_delay = min_delay_for(event);
                let actual = scaled.saturating_sub(credit).max(min_delay);
                if actual > 0 {
                    steps.push(PlannedStep::TimelineSleep { ms: actual });
                }
            }

            // Simulation.
            if matches!(event, InputEvent::KeyCombo { .. }) {
                // Annotation only — not simulated, contributes no post settle.
                prev_post_ms = 0;
                continue;
            }
            push_simulate(&mut steps, event);
            // Pointer samples have no fixed settle, scroll ticks use only 1ms,
            // and discrete events retain the reliability settle.
            let post_ms = if matches!(event, InputEvent::MouseMove { .. }) {
                0
            } else if matches!(event, InputEvent::Scroll { .. }) {
                1
            } else if speed <= 2.0 {
                10
            } else {
                1
            };
            if post_ms > 0 {
                steps.push(PlannedStep::Sleep { ms: post_ms });
            }
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
        InputEvent::MouseMove { .. } => 0,
        _ => 1,
    }
}

fn prepare_events(events: &[InputEvent]) -> Vec<PreparedEvent<'_>> {
    if has_free_pointer_path(events) {
        return events
            .iter()
            .enumerate()
            .map(|(source_index, event)| PreparedEvent {
                event: Cow::Borrowed(event),
                source_index: Some(source_index),
            })
            .collect();
    }

    let mut prepared = Vec::with_capacity(events.len() * 2);
    let mut previous_cursor = None;
    for (source_index, event) in events.iter().enumerate() {
        if let Some((x, y)) = cursor_position(event) {
            if let Some((previous_x, previous_y, previous_timestamp)) = previous_cursor {
                append_legacy_cursor_samples(
                    &mut prepared,
                    previous_x,
                    previous_y,
                    previous_timestamp,
                    x,
                    y,
                    event.timestamp(),
                );
            }
            previous_cursor = Some((x, y, event.timestamp()));
        }
        prepared.push(PreparedEvent {
            event: Cow::Borrowed(event),
            source_index: Some(source_index),
        });
    }
    prepared.sort_by_key(|prepared_event| prepared_event.event.timestamp());
    prepared
}

fn has_free_pointer_path(events: &[InputEvent]) -> bool {
    let mut pressed_button_count = 0_u32;
    for event in events {
        match event {
            InputEvent::ButtonPress { .. } => {
                pressed_button_count = pressed_button_count.saturating_add(1);
            }
            InputEvent::ButtonRelease { .. } => {
                pressed_button_count = pressed_button_count.saturating_sub(1);
            }
            InputEvent::MouseMove { .. } if pressed_button_count == 0 => return true,
            _ => {}
        }
    }
    false
}

fn cursor_position(event: &InputEvent) -> Option<(f64, f64)> {
    match event {
        InputEvent::ButtonPress { x, y, .. }
        | InputEvent::ButtonRelease { x, y, .. }
        | InputEvent::MouseMove { x, y, .. } => Some((*x, *y)),
        _ => None,
    }
}

fn append_legacy_cursor_samples<'a>(
    prepared: &mut Vec<PreparedEvent<'a>>,
    from_x: f64,
    from_y: f64,
    from_timestamp: i64,
    to_x: f64,
    to_y: f64,
    to_timestamp: i64,
) {
    let gap_ms = to_timestamp.saturating_sub(from_timestamp);
    let distance = (to_x - from_x).hypot(to_y - from_y);
    if gap_ms <= CURSOR_SAMPLE_INTERVAL_MS || distance < 1.0 {
        return;
    }

    let ideal_duration_ms = (distance / LEGACY_CURSOR_PIXELS_PER_MS).round() as i64;
    let duration_ms = ideal_duration_ms
        .clamp(LEGACY_CURSOR_MIN_DURATION_MS, LEGACY_CURSOR_MAX_DURATION_MS)
        .min(gap_ms);
    let movement_start = to_timestamp.saturating_sub(duration_ms);
    let mut sample_timestamp = movement_start.saturating_add(CURSOR_SAMPLE_INTERVAL_MS);
    while sample_timestamp < to_timestamp {
        let progress = (sample_timestamp - movement_start) as f64 / duration_ms as f64;
        prepared.push(PreparedEvent {
            event: Cow::Owned(InputEvent::MouseMove {
                x: from_x + (to_x - from_x) * progress,
                y: from_y + (to_y - from_y) * progress,
                timestamp: sample_timestamp,
            }),
            source_index: None,
        });
        sample_timestamp = sample_timestamp.saturating_add(CURSOR_SAMPLE_INTERVAL_MS);
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
    fn button_release(btn: &str, x: f64, y: f64, ts: i64) -> InputEvent {
        InputEvent::ButtonRelease {
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
                PlannedStep::Sleep { ms } | PlannedStep::TimelineSleep { ms } => Some(*ms),
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
    fn legacy_click_only_recording_gains_smooth_cursor_samples() {
        let events = vec![
            button_press("Left", 0.0, 0.0, 0),
            button_release("Left", 0.0, 0.0, 10),
            button_press("Left", 400.0, 200.0, 1_000),
        ];
        let prepared = prepare_events(&events);
        let synthetic_count = prepared
            .iter()
            .filter(|event| event.source_index.is_none())
            .count();

        assert!(
            synthetic_count >= 20,
            "expected a dense compatibility path, got {synthetic_count} samples"
        );
    }

    #[test]
    fn legacy_synthetic_samples_do_not_emit_fake_timeline_indexes() {
        let events = vec![
            button_press("Left", 0.0, 0.0, 0),
            button_release("Left", 0.0, 0.0, 10),
            button_press("Left", 400.0, 200.0, 1_000),
        ];
        let plan = PlaybackPlan::compile(&events, 1.0).unwrap();
        let emitted_indexes: Vec<_> = plan
            .steps
            .iter()
            .filter_map(|step| match step {
                PlannedStep::EmitPosition { index } => Some(*index),
                _ => None,
            })
            .collect();

        assert!(emitted_indexes.iter().all(|index| *index < events.len()));
    }

    #[test]
    fn recording_with_free_pointer_path_is_not_reinterpolated() {
        let events = vec![
            mouse_move(0.0, 0.0, 0),
            mouse_move(10.0, 10.0, 8),
            mouse_move(20.0, 20.0, 16),
        ];
        let prepared = prepare_events(&events);

        assert_eq!(prepared.len(), events.len());
    }

    #[test]
    fn mouse_move_ui_updates_are_throttled_without_dropping_input_samples() {
        let events = vec![
            button_press("Left", 0.0, 0.0, 0),
            mouse_move(10.0, 10.0, 8),
            mouse_move(20.0, 20.0, 16),
            mouse_move(30.0, 30.0, 24),
            mouse_move(40.0, 40.0, 41),
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
        assert_eq!(positions, vec![0, 1, 4]);
        let replayed_x: Vec<f64> = plan
            .steps
            .iter()
            .filter_map(|step| match step {
                PlannedStep::Simulate(EventType::MouseMove { x, .. }) => Some(*x),
                _ => None,
            })
            .collect();
        assert!([10.0, 20.0, 30.0, 40.0]
            .iter()
            .all(|x| replayed_x.contains(x)));
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
    fn mouse_move_has_no_fixed_settle_delay_at_high_speed() {
        let events = vec![
            mouse_move(0.0, 0.0, 0),
            mouse_move(1.0, 1.0, 1),
            mouse_move(2.0, 2.0, 2),
        ];
        let plan = PlaybackPlan::compile(&events, 1000.0).unwrap();
        assert_eq!(total_sleep_ms(&plan.steps), 50);
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
    fn min_delay_for_mouse_move_returns_zero_others_return_one() {
        assert_eq!(min_delay_for(&mouse_move(0.0, 0.0, 0)), 0);
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
    fn mouse_move_ui_throttle_emits_on_33ms_boundary() {
        let events = vec![
            mouse_move(0.0, 0.0, 0),
            mouse_move(1.0, 1.0, 32),
            mouse_move(2.0, 2.0, 33),
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
        assert_eq!(positions, vec![0, 2]);
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
    fn compile_space_switch_settle_sleeps_sit_between_hops_only() {
        let compile_hops = |count: u32| {
            PlaybackPlan::compile(
                &[InputEvent::SpaceSwitch {
                    direction: "right".into(),
                    count,
                    timestamp: 0,
                }],
                1.0,
            )
            .unwrap()
        };
        let settle_count = |plan: &PlaybackPlan| {
            plan.steps
                .iter()
                .filter(|s| matches!(s, PlannedStep::Sleep { ms: 150 }))
                .count()
        };

        // The 150ms settle pause exists only to let a PREVIOUS hop's Space
        // animation finish — a single hop must not pause at all, and n hops
        // pause exactly n-1 times. Pins the `hop > 0` guard against >= / ==.
        assert_eq!(settle_count(&compile_hops(1)), 0, "single hop: no settle");
        assert_eq!(settle_count(&compile_hops(3)), 2, "settles go between hops");
    }

    #[test]
    fn compile_space_switch_count_zero_still_plays_one_hop() {
        // `count.max(1)`: a degenerate count of 0 replays as a single hop.
        let events = vec![InputEvent::SpaceSwitch {
            direction: "right".into(),
            count: 0,
            timestamp: 0,
        }];
        let plan = PlaybackPlan::compile(&events, 1.0).unwrap();
        let sims = plan
            .steps
            .iter()
            .filter(|s| matches!(s, PlannedStep::Simulate(_)))
            .count();
        assert_eq!(sims, 4, "one hop of 4 key events");
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
    fn speed_1x_does_not_pause_after_position_notifications() {
        let events = vec![key_press("A", 0), key_press("B", 100)];
        let plan = PlaybackPlan::compile(&events, 1.0).unwrap();
        assert!(matches!(
            plan.steps.first(),
            Some(PlannedStep::EmitPosition { index: 0 })
        ));
        assert!(matches!(
            plan.steps.get(1),
            Some(PlannedStep::Sleep { ms: 50 })
        ));
    }

    #[test]
    fn overhead_credit_reduces_inter_event_sleep_at_slow_speed() {
        // The inter-event sleep credits the fixed settle sleeps that bracket the
        // event so the time between simulations matches the recording. For a
        // 100ms gap between two key presses at 1x credits the previous event's
        // 10ms post settle, so the timeline portion is exactly 90ms.
        let events = vec![key_press("A", 0), key_press("B", 100)];
        let plan = PlaybackPlan::compile(&events, 1.0).unwrap();
        // TimelineSleep is reserved for the inter-event portion; fixed
        // reliability settles remain relative Sleep steps.
        let sleeps: Vec<u64> = plan
            .steps
            .iter()
            .filter_map(|s| match s {
                PlannedStep::TimelineSleep { ms } => Some(*ms),
                _ => None,
            })
            .collect();
        assert!(
            sleeps.contains(&90),
            "expected an exact 90ms inter-event sleep; sleeps were {:?}",
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
        // previous post (10) + pre-press settle (10) = 20, leaving a 180ms
        // inter-event sleep.
        let events = vec![
            button_press("Left", 0.0, 0.0, 0),
            button_press("Left", 0.0, 0.0, 200),
        ];
        let plan = PlaybackPlan::compile(&events, 1.0).unwrap();
        let sleeps: Vec<u64> = plan
            .steps
            .iter()
            .filter_map(|s| match s {
                PlannedStep::TimelineSleep { ms } => Some(*ms),
                _ => None,
            })
            .collect();
        assert!(
            sleeps.contains(&180),
            "expected a 180ms inter-event sleep; sleeps were {:?}",
            sleeps
        );
    }

    #[test]
    fn cursor_ui_throttle_uses_timestamp_delta() {
        let events = vec![mouse_move(0.0, 0.0, 25), mouse_move(1.0, 1.0, 30)];
        let plan = PlaybackPlan::compile(&events, 1.0).unwrap();
        let positions: Vec<usize> = plan
            .steps
            .iter()
            .filter_map(|s| match s {
                PlannedStep::EmitPosition { index } => Some(*index),
                _ => None,
            })
            .collect();
        assert!(
            !positions.contains(&1),
            "a 5ms delta must throttle the position emit; positions={:?}",
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
                PlannedStep::Sleep { ms } | PlannedStep::TimelineSleep { ms } => Some(*ms),
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
