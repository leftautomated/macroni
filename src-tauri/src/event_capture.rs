//! Translates `rdev::EventType`s into `InputEvent`s. Owns the modifier and
//! button state machines, the last-known mouse position, the drag-detection
//! filter, and combo recognition.
//!
//! Single-threaded by design — instantiate once per rdev listener thread; no
//! interior mutability required.

use std::collections::HashSet;

use rdev::{Button, EventType, Key};

use crate::key_mapping::{
    button_to_string, get_character_with_modifiers, is_modifier_key, key_to_string,
};
use crate::types::InputEvent;

pub struct EventCapture {
    pressed_modifiers: HashSet<Key>,
    pressed_buttons: HashSet<Button>,
    last_mouse_position: Option<(f64, f64)>,
}

impl EventCapture {
    pub fn new() -> Self {
        Self {
            pressed_modifiers: HashSet::new(),
            pressed_buttons: HashSet::new(),
            last_mouse_position: None,
        }
    }

    /// Clear modifier/button state. Call at the start of every new recording
    /// session so keys or mouse buttons that were held when the previous
    /// session ended (and whose release events were dropped while
    /// `is_recording == false`) don't poison the new session.
    ///
    /// `last_mouse_position` is intentionally preserved — the cursor's last
    /// known location is still a valid starting point.
    pub fn reset(&mut self) {
        self.pressed_modifiers.clear();
        self.pressed_buttons.clear();
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
                self.pressed_buttons.insert(button);
                let (x, y) = self.last_mouse_position.unwrap_or((0.0, 0.0));
                out.push(InputEvent::ButtonPress {
                    button: button_to_string(button),
                    x,
                    y,
                    timestamp: timestamp_ms,
                });
            }
            EventType::ButtonRelease(button) => {
                self.pressed_buttons.remove(&button);
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
                if !self.pressed_buttons.is_empty() {
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
}

impl Default for EventCapture {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn mouse_move_without_button_pressed_emits_nothing() {
        let mut cap = EventCapture::new();
        let out = cap.on_rdev_event(EventType::MouseMove { x: 100.0, y: 200.0 }, ts());
        assert!(out.is_empty(), "drag filter — got {:?}", out);
    }

    #[test]
    fn mouse_move_with_button_pressed_emits_mouse_move() {
        let mut cap = EventCapture::new();
        cap.on_rdev_event(EventType::MouseMove { x: 50.0, y: 60.0 }, ts());
        cap.on_rdev_event(EventType::ButtonPress(Button::Left), ts() + 1);
        let out = cap.on_rdev_event(EventType::MouseMove { x: 100.0, y: 200.0 }, ts() + 2);
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
    fn button_release_clears_drag_state() {
        let mut cap = EventCapture::new();
        cap.on_rdev_event(EventType::ButtonPress(Button::Left), ts());
        cap.on_rdev_event(EventType::ButtonRelease(Button::Left), ts() + 1);
        let out = cap.on_rdev_event(EventType::MouseMove { x: 1.0, y: 1.0 }, ts() + 2);
        assert!(
            out.is_empty(),
            "after button release, drag filter should re-engage"
        );
    }

    #[test]
    fn reset_clears_pressed_modifiers_and_buttons() {
        let mut cap = EventCapture::new();
        // Hold Cmd + Left button, but never release either before reset.
        cap.on_rdev_event(EventType::KeyPress(Key::MetaLeft), ts());
        cap.on_rdev_event(EventType::ButtonPress(Button::Left), ts() + 1);

        cap.reset();

        // After reset, a plain KeyPress(A) must not produce a stale KeyCombo,
        // and a MouseMove must not be emitted as a drag.
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
            move_out.is_empty(),
            "button state should be cleared by reset; mouse move should not emit"
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
