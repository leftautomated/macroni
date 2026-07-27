//! Native macOS input simulation that is not exposed by `rdev`.

use core_graphics::{
    event::{CGEvent, CGEventFlags, CGEventTapLocation, CGKeyCode, EventField},
    event_source::{CGEventSource, CGEventSourceStateID},
};
use rdev::Key;

pub(super) fn simulate_key_repeat(key: Key) -> Result<(), String> {
    let event = key_repeat_event(key)?;
    event.post(CGEventTapLocation::HID);
    Ok(())
}

fn key_repeat_event(key: Key) -> Result<CGEvent, String> {
    let keycode =
        keycode_from_key(key).ok_or_else(|| format!("unsupported macOS repeat key: {key:?}"))?;
    let source = CGEventSource::new(CGEventSourceStateID::CombinedSessionState)
        .map_err(|_| "could not create a macOS event source".to_string())?;
    let event = CGEvent::new_keyboard_event(source, keycode, true)
        .map_err(|_| "could not create a macOS key repeat event".to_string())?;
    event.set_flags(combined_session_flags());
    event.set_integer_value_field(EventField::KEYBOARD_EVENT_AUTOREPEAT, 1);
    Ok(event)
}

fn combined_session_flags() -> CGEventFlags {
    // SAFETY: CGEventSourceFlagsState accepts an enum value and returns a
    // bitmask by value; it has no pointer or lifetime requirements.
    let flags = unsafe { CGEventSourceFlagsState(CGEventSourceStateID::CombinedSessionState) };
    CGEventFlags::from_bits_truncate(flags)
}

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGEventSourceFlagsState(state_id: CGEventSourceStateID) -> u64;
}

// Keep this mapping aligned with the macOS mapping in the pinned rdev fork so
// ordinary key downs and native repeat key downs use the same virtual keycode.
fn keycode_from_key(key: Key) -> Option<CGKeyCode> {
    match key {
        Key::Alt => Some(58),
        Key::AltGr => Some(61),
        Key::Backspace => Some(51),
        Key::CapsLock => Some(57),
        Key::ControlLeft => Some(59),
        Key::ControlRight => Some(62),
        Key::DownArrow => Some(125),
        Key::Escape => Some(53),
        Key::F1 => Some(122),
        Key::F2 => Some(120),
        Key::F3 => Some(99),
        Key::F4 => Some(118),
        Key::F5 => Some(96),
        Key::F6 => Some(97),
        Key::F7 => Some(98),
        Key::F8 => Some(100),
        Key::F9 => Some(101),
        Key::F10 => Some(109),
        Key::F11 => Some(103),
        Key::F12 => Some(111),
        Key::LeftArrow => Some(123),
        Key::MetaLeft => Some(55),
        Key::MetaRight => Some(54),
        Key::Return => Some(36),
        Key::RightArrow => Some(124),
        Key::ShiftLeft => Some(56),
        Key::ShiftRight => Some(60),
        Key::Space => Some(49),
        Key::Tab => Some(48),
        Key::UpArrow => Some(126),
        Key::BackQuote => Some(50),
        Key::Num1 => Some(18),
        Key::Num2 => Some(19),
        Key::Num3 => Some(20),
        Key::Num4 => Some(21),
        Key::Num5 => Some(23),
        Key::Num6 => Some(22),
        Key::Num7 => Some(26),
        Key::Num8 => Some(28),
        Key::Num9 => Some(25),
        Key::Num0 => Some(29),
        Key::Minus => Some(27),
        Key::Equal => Some(24),
        Key::KeyQ => Some(12),
        Key::KeyW => Some(13),
        Key::KeyE => Some(14),
        Key::KeyR => Some(15),
        Key::KeyT => Some(17),
        Key::KeyY => Some(16),
        Key::KeyU => Some(32),
        Key::KeyI => Some(34),
        Key::KeyO => Some(31),
        Key::KeyP => Some(35),
        Key::LeftBracket => Some(33),
        Key::RightBracket => Some(30),
        Key::KeyA => Some(0),
        Key::KeyS => Some(1),
        Key::KeyD => Some(2),
        Key::KeyF => Some(3),
        Key::KeyG => Some(5),
        Key::KeyH => Some(4),
        Key::KeyJ => Some(38),
        Key::KeyK => Some(40),
        Key::KeyL => Some(37),
        Key::SemiColon => Some(41),
        Key::Quote => Some(39),
        Key::BackSlash => Some(42),
        Key::KeyZ => Some(6),
        Key::KeyX => Some(7),
        Key::KeyC => Some(8),
        Key::KeyV => Some(9),
        Key::KeyB => Some(11),
        Key::KeyN => Some(45),
        Key::KeyM => Some(46),
        Key::Comma => Some(43),
        Key::Dot => Some(47),
        Key::Slash => Some(44),
        Key::Function => Some(63),
        Key::Unknown(code) => code.try_into().ok(),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_repeat_event_sets_native_autorepeat_field() {
        let event = key_repeat_event(Key::KeyE).expect("repeat event should be created");

        assert_eq!(
            event.get_integer_value_field(EventField::KEYBOARD_EVENT_AUTOREPEAT),
            1
        );
    }

    #[test]
    fn key_repeat_event_uses_the_rdev_virtual_keycode() {
        let event = key_repeat_event(Key::KeyE).expect("repeat event should be created");

        assert_eq!(
            event.get_integer_value_field(EventField::KEYBOARD_EVENT_KEYCODE),
            14
        );
    }

    #[test]
    fn keycode_from_key_rejects_unsupported_keys() {
        assert_eq!(keycode_from_key(Key::Delete), None);
    }
}
