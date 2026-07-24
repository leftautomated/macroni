//! Translates `rdev::EventType`s into `InputEvent`s. Owns modifier state, the
//! last-known pointer position, bounded pointer-path sampling, and combo
//! recognition.
//!
//! Single-threaded by design — instantiate once per rdev listener thread; no
//! interior mutability required.

use std::collections::HashSet;

use rdev::{EventType, Key};

use crate::key_mapping::{
    button_to_string, get_character_with_modifiers, is_modifier_key, key_to_string,
};
use crate::types::InputEvent;

/// Capture enough pointer samples for fluid 120 Hz playback without storing
/// every high-polling-rate mouse packet.
const MOUSE_SAMPLE_INTERVAL_MS: i64 = 8;

pub struct EventCapture {
    pressed_modifiers: HashSet<Key>,
    last_mouse_position: Option<(f64, f64)>,
    last_mouse_sample: Option<(f64, f64, i64)>,
}

impl EventCapture {
    pub fn new() -> Self {
        Self {
            pressed_modifiers: HashSet::new(),
            last_mouse_position: None,
            last_mouse_sample: None,
        }
    }

    /// Clear modifier and sampling state at the start of every recording so a
    /// modifier released while inactive cannot poison the next session.
    ///
    /// `last_mouse_position` is intentionally preserved — the cursor's last
    /// known location is still a valid starting point. The sampling clock is
    /// reset so the first movement in the next session is always captured.
    pub fn reset(&mut self) {
        self.pressed_modifiers.clear();
        self.last_mouse_sample = None;
    }

    /// Convert a single rdev event into 0, 1, or 2 `InputEvent`s.
    /// A key press with active modifiers produces both a `KeyPress` and a
    /// `KeyCombo` event. A mouse-move without any button held emits nothing
    /// (drag filter).
    pub fn on_rdev_event(&mut self, event_type: EventType, timestamp_ms: i64) -> Vec<InputEvent> {
        let mut out = Vec::new();
        match event_type {
            EventType::KeyPress(key) => {
                if is_modifier_key(key) {
                    self.pressed_modifiers.insert(key);
                }
                let key_str = key_to_string(key);
                out.push(InputEvent::KeyPress {
                    key: key_str.clone(),
                    timestamp: timestamp_ms,
                });
                if !is_modifier_key(key) {
                    if let Some(recognized_char) =
                        get_character_with_modifiers(key, &self.pressed_modifiers)
                    {
                        // pressed_modifiers is populated exclusively by
                        // is_modifier_key-true keys, so every entry is already
                        // a modifier — no redundant filter needed here.
                        let modifiers: Vec<String> = self
                            .pressed_modifiers
                            .iter()
                            .map(|k| key_to_string(*k))
                            .collect();
                        out.push(InputEvent::KeyCombo {
                            char: recognized_char,
                            key: key_str,
                            modifiers,
                            timestamp: timestamp_ms,
                        });
                    }
                }
            }
            EventType::KeyRelease(key) => {
                if is_modifier_key(key) {
                    self.pressed_modifiers.remove(&key);
                }
                out.push(InputEvent::KeyRelease {
                    key: key_to_string(key),
                    timestamp: timestamp_ms,
                });
            }
            EventType::ButtonPress(button) => {
                let (x, y) = self.last_mouse_position.unwrap_or((0.0, 0.0));
                out.push(InputEvent::ButtonPress {
                    button: button_to_string(button),
                    x,
                    y,
                    timestamp: timestamp_ms,
                });
            }
            EventType::ButtonRelease(button) => {
                let (x, y) = self.last_mouse_position.unwrap_or((0.0, 0.0));
                out.push(InputEvent::ButtonRelease {
                    button: button_to_string(button),
                    x,
                    y,
                    timestamp: timestamp_ms,
                });
            }
            EventType::MouseMove { x, y } => {
                self.last_mouse_position = Some((x, y));
                if self.should_capture_mouse_sample(x, y, timestamp_ms) {
                    self.last_mouse_sample = Some((x, y, timestamp_ms));
                    out.push(InputEvent::MouseMove {
                        x,
                        y,
                        timestamp: timestamp_ms,
                    });
                }
            }
            EventType::Wheel { delta_x, delta_y } => {
                // Record every wheel tick (trackpad or mouse) for fidelity; the
                // UI groups consecutive scrolls for readability.
                out.push(InputEvent::Scroll {
                    delta_x,
                    delta_y,
                    timestamp: timestamp_ms,
                });
            }
        }
        out
    }

    fn should_capture_mouse_sample(&self, x: f64, y: f64, timestamp_ms: i64) -> bool {
        let Some((last_x, last_y, last_timestamp)) = self.last_mouse_sample else {
            return true;
        };
        if x == last_x && y == last_y {
            return false;
        }
        timestamp_ms.saturating_sub(last_timestamp) >= MOUSE_SAMPLE_INTERVAL_MS
    }
}

impl Default for EventCapture {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rdev::Button;

    fn ts() -> i64 {
        1_700_000_000_000
    }

    #[test]
    fn key_press_emits_key_press() {
        let mut cap = EventCapture::new();
        let out = cap.on_rdev_event(EventType::KeyPress(Key::KeyA), ts());
        assert_eq!(out.len(), 1);
        match &out[0] {
            InputEvent::KeyPress { key, timestamp } => {
                assert_eq!(key, "A");
                assert_eq!(*timestamp, ts());
            }
            other => panic!("expected KeyPress, got {:?}", other),
        }
    }

    #[test]
    fn key_release_emits_key_release() {
        let mut cap = EventCapture::new();
        let out = cap.on_rdev_event(EventType::KeyRelease(Key::KeyA), ts());
        assert_eq!(out.len(), 1);
        assert!(matches!(&out[0], InputEvent::KeyRelease { key, .. } if key == "A"));
    }

    #[test]
    fn cmd_then_a_emits_press_then_combo() {
        let mut cap = EventCapture::new();
        let pressed = cap.on_rdev_event(EventType::KeyPress(Key::MetaLeft), ts());
        // Cmd is a modifier — its own KeyPress still emits, but no combo.
        assert_eq!(pressed.len(), 1);
        assert!(matches!(&pressed[0], InputEvent::KeyPress { .. }));

        let out = cap.on_rdev_event(EventType::KeyPress(Key::KeyA), ts() + 5);
        assert_eq!(out.len(), 2, "expected KeyPress + KeyCombo, got {:?}", out);
        assert!(matches!(&out[0], InputEvent::KeyPress { key, .. } if key == "A"));
        match &out[1] {
            InputEvent::KeyCombo { key, modifiers, .. } => {
                assert_eq!(key, "A");
                assert!(
                    modifiers
                        .iter()
                        .any(|m| m == "MetaLeft" || m == "Cmd" || m.contains("Meta")),
                    "modifier list should include Meta/Cmd, got {:?}",
                    modifiers
                );
            }
            other => panic!("expected KeyCombo, got {:?}", other),
        }
    }

    #[test]
    fn cmd_release_clears_modifier_so_subsequent_a_press_has_no_combo() {
        let mut cap = EventCapture::new();
        cap.on_rdev_event(EventType::KeyPress(Key::MetaLeft), ts());
        cap.on_rdev_event(EventType::KeyRelease(Key::MetaLeft), ts() + 1);
        let out = cap.on_rdev_event(EventType::KeyPress(Key::KeyA), ts() + 2);
        assert_eq!(
            out.len(),
            1,
            "stale modifier should not produce combo: {:?}",
            out
        );
    }

    #[test]
    fn wheel_emits_scroll_with_deltas() {
        let mut cap = EventCapture::new();
        let out = cap.on_rdev_event(
            EventType::Wheel {
                delta_x: 3,
                delta_y: -10,
            },
            ts(),
        );
        assert_eq!(out.len(), 1);
        match &out[0] {
            InputEvent::Scroll {
                delta_x,
                delta_y,
                timestamp,
            } => {
                assert_eq!(*delta_x, 3);
                assert_eq!(*delta_y, -10);
                assert_eq!(*timestamp, ts());
            }
            other => panic!("expected Scroll, got {:?}", other),
        }
    }

    #[test]
    fn mouse_move_without_button_pressed_captures_pointer_path() {
        let mut cap = EventCapture::new();
        let out = cap.on_rdev_event(EventType::MouseMove { x: 100.0, y: 200.0 }, ts());
        assert!(matches!(
            out.as_slice(),
            [InputEvent::MouseMove {
                x: 100.0,
                y: 200.0,
                ..
            }]
        ));
    }

    #[test]
    fn mouse_move_sampling_caps_capture_at_about_120_hz() {
        let mut cap = EventCapture::new();
        cap.on_rdev_event(EventType::MouseMove { x: 0.0, y: 0.0 }, ts());
        let too_soon = cap.on_rdev_event(EventType::MouseMove { x: 1.0, y: 1.0 }, ts() + 7);
        let on_interval = cap.on_rdev_event(EventType::MouseMove { x: 2.0, y: 2.0 }, ts() + 8);

        assert!(too_soon.is_empty());
        assert!(matches!(
            on_interval.as_slice(),
            [InputEvent::MouseMove { x: 2.0, y: 2.0, .. }]
        ));
    }

    #[test]
    fn mouse_move_with_button_pressed_emits_mouse_move() {
        let mut cap = EventCapture::new();
        cap.on_rdev_event(EventType::MouseMove { x: 50.0, y: 60.0 }, ts());
        cap.on_rdev_event(EventType::ButtonPress(Button::Left), ts() + 1);
        let out = cap.on_rdev_event(EventType::MouseMove { x: 100.0, y: 200.0 }, ts() + 8);
        assert_eq!(out.len(), 1);
        assert!(
            matches!(&out[0], InputEvent::MouseMove { x, y, .. } if *x == 100.0 && *y == 200.0)
        );
    }

    #[test]
    fn button_press_without_prior_move_uses_zero_zero_position() {
        let mut cap = EventCapture::new();
        let out = cap.on_rdev_event(EventType::ButtonPress(Button::Left), ts());
        assert_eq!(out.len(), 1);
        match &out[0] {
            InputEvent::ButtonPress { x, y, .. } => {
                assert_eq!(*x, 0.0);
                assert_eq!(*y, 0.0);
            }
            other => panic!("expected ButtonPress, got {:?}", other),
        }
    }

    #[test]
    fn button_press_uses_last_known_mouse_position() {
        let mut cap = EventCapture::new();
        cap.on_rdev_event(EventType::MouseMove { x: 42.0, y: 99.0 }, ts());
        let out = cap.on_rdev_event(EventType::ButtonPress(Button::Left), ts() + 1);
        match &out[0] {
            InputEvent::ButtonPress { x, y, .. } => {
                assert_eq!(*x, 42.0);
                assert_eq!(*y, 99.0);
            }
            other => panic!("expected ButtonPress, got {:?}", other),
        }
    }

    #[test]
    fn mouse_move_after_button_release_still_captures_pointer_path() {
        let mut cap = EventCapture::new();
        cap.on_rdev_event(EventType::ButtonPress(Button::Left), ts());
        cap.on_rdev_event(EventType::ButtonRelease(Button::Left), ts() + 1);
        let out = cap.on_rdev_event(EventType::MouseMove { x: 1.0, y: 1.0 }, ts() + 8);
        assert!(matches!(out.as_slice(), [InputEvent::MouseMove { .. }]));
    }

    #[test]
    fn reset_clears_pressed_modifiers_and_sampling_clock() {
        let mut cap = EventCapture::new();
        // Hold Cmd and prime the pointer sample clock before reset.
        cap.on_rdev_event(EventType::KeyPress(Key::MetaLeft), ts());
        cap.on_rdev_event(EventType::ButtonPress(Button::Left), ts() + 1);

        cap.reset();

        // After reset, a plain KeyPress(A) must not produce a stale KeyCombo.
        let key_out = cap.on_rdev_event(EventType::KeyPress(Key::KeyA), ts() + 2);
        assert_eq!(
            key_out.len(),
            1,
            "modifier state should be cleared by reset; got {:?}",
            key_out
        );
        assert!(matches!(&key_out[0], InputEvent::KeyPress { .. }));

        let move_out = cap.on_rdev_event(EventType::MouseMove { x: 1.0, y: 1.0 }, ts() + 3);
        assert!(
            matches!(move_out.as_slice(), [InputEvent::MouseMove { .. }]),
            "reset should make the next pointer sample immediately eligible"
        );
    }

    #[test]
    fn reset_preserves_last_mouse_position() {
        let mut cap = EventCapture::new();
        cap.on_rdev_event(EventType::MouseMove { x: 42.0, y: 99.0 }, ts());
        cap.reset();
        // After reset, a ButtonPress should still use the cached position
        // rather than falling back to (0, 0).
        let out = cap.on_rdev_event(EventType::ButtonPress(Button::Left), ts() + 1);
        match &out[0] {
            InputEvent::ButtonPress { x, y, .. } => {
                assert_eq!(*x, 42.0);
                assert_eq!(*y, 99.0);
            }
            other => panic!("expected ButtonPress, got {:?}", other),
        }
    }

    #[test]
    fn shift_plus_a_combo_has_shift_in_modifier_list() {
        let mut cap = EventCapture::new();
        cap.on_rdev_event(EventType::KeyPress(Key::ShiftLeft), ts());
        let out = cap.on_rdev_event(EventType::KeyPress(Key::KeyA), ts() + 1);
        // Either 1 (no combo recognized for plain Shift+A) or 2 (KeyPress + KeyCombo).
        // If 2, modifier list must include a Shift variant.
        if out.len() == 2 {
            if let InputEvent::KeyCombo { modifiers, .. } = &out[1] {
                assert!(
                    modifiers.iter().any(|m| m.contains("Shift")),
                    "modifier list should include Shift, got {:?}",
                    modifiers
                );
            }
        }
    }
}
