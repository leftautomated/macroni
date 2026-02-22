//! Key and button string conversion utilities

use rdev::{Key, Button};

/// Converts an `rdev::Key` to its string representation
pub fn key_to_string(key: Key) -> String {
    match key {
        Key::Alt => "Alt".to_string(),
        Key::AltGr => "AltGr".to_string(),
        Key::Backspace => "Backspace".to_string(),
        Key::CapsLock => "CapsLock".to_string(),
        Key::ControlLeft => "Ctrl".to_string(),
        Key::ControlRight => "Ctrl".to_string(),
        Key::Delete => "Delete".to_string(),
        Key::DownArrow => "↓".to_string(),
        Key::End => "End".to_string(),
        Key::Escape => "Esc".to_string(),
        Key::F1 => "F1".to_string(),
        Key::F2 => "F2".to_string(),
        Key::F3 => "F3".to_string(),
        Key::F4 => "F4".to_string(),
        Key::F5 => "F5".to_string(),
        Key::F6 => "F6".to_string(),
        Key::F7 => "F7".to_string(),
        Key::F8 => "F8".to_string(),
        Key::F9 => "F9".to_string(),
        Key::F10 => "F10".to_string(),
        Key::F11 => "F11".to_string(),
        Key::F12 => "F12".to_string(),
        Key::Home => "Home".to_string(),
        Key::LeftArrow => "←".to_string(),
        Key::MetaLeft => "Cmd".to_string(),
        Key::MetaRight => "Cmd".to_string(),
        Key::PageDown => "PgDn".to_string(),
        Key::PageUp => "PgUp".to_string(),
        Key::Return => "Enter".to_string(),
        Key::RightArrow => "→".to_string(),
        Key::ShiftLeft => "Shift".to_string(),
        Key::ShiftRight => "Shift".to_string(),
        Key::Space => "Space".to_string(),
        Key::Tab => "Tab".to_string(),
        Key::UpArrow => "↑".to_string(),
        Key::PrintScreen => "PrtSc".to_string(),
        Key::ScrollLock => "ScrollLock".to_string(),
        Key::Pause => "Pause".to_string(),
        Key::NumLock => "NumLock".to_string(),
        Key::BackQuote => "`".to_string(),
        Key::Num1 => "1".to_string(),
        Key::Num2 => "2".to_string(),
        Key::Num3 => "3".to_string(),
        Key::Num4 => "4".to_string(),
        Key::Num5 => "5".to_string(),
        Key::Num6 => "6".to_string(),
        Key::Num7 => "7".to_string(),
        Key::Num8 => "8".to_string(),
        Key::Num9 => "9".to_string(),
        Key::Num0 => "0".to_string(),
        Key::Minus => "-".to_string(),
        Key::Equal => "=".to_string(),
        Key::LeftBracket => "[".to_string(),
        Key::RightBracket => "]".to_string(),
        Key::BackSlash => "\\".to_string(),
        Key::SemiColon => ";".to_string(),
        Key::Quote => "'".to_string(),
        Key::Comma => ",".to_string(),
        Key::Dot => ".".to_string(),
        Key::Slash => "/".to_string(),
        Key::KeyA => "A".to_string(),
        Key::KeyB => "B".to_string(),
        Key::KeyC => "C".to_string(),
        Key::KeyD => "D".to_string(),
        Key::KeyE => "E".to_string(),
        Key::KeyF => "F".to_string(),
        Key::KeyG => "G".to_string(),
        Key::KeyH => "H".to_string(),
        Key::KeyI => "I".to_string(),
        Key::KeyJ => "J".to_string(),
        Key::KeyK => "K".to_string(),
        Key::KeyL => "L".to_string(),
        Key::KeyM => "M".to_string(),
        Key::KeyN => "N".to_string(),
        Key::KeyO => "O".to_string(),
        Key::KeyP => "P".to_string(),
        Key::KeyQ => "Q".to_string(),
        Key::KeyR => "R".to_string(),
        Key::KeyS => "S".to_string(),
        Key::KeyT => "T".to_string(),
        Key::KeyU => "U".to_string(),
        Key::KeyV => "V".to_string(),
        Key::KeyW => "W".to_string(),
        Key::KeyX => "X".to_string(),
        Key::KeyY => "Y".to_string(),
        Key::KeyZ => "Z".to_string(),
        Key::IntlBackslash => "\\".to_string(),
        Key::Insert => "Ins".to_string(),
        Key::KpReturn => "Enter".to_string(),
        Key::KpMinus => "-".to_string(),
        Key::KpPlus => "+".to_string(),
        Key::KpMultiply => "*".to_string(),
        Key::KpDivide => "/".to_string(),
        Key::Kp0 => "0".to_string(),
        Key::Kp1 => "1".to_string(),
        Key::Kp2 => "2".to_string(),
        Key::Kp3 => "3".to_string(),
        Key::Kp4 => "4".to_string(),
        Key::Kp5 => "5".to_string(),
        Key::Kp6 => "6".to_string(),
        Key::Kp7 => "7".to_string(),
        Key::Kp8 => "8".to_string(),
        Key::Kp9 => "9".to_string(),
        _ => format!("Unknown({:?})", key),
    }
}

/// Converts a string representation back to an `rdev::Key`
/// Returns `None` if the string doesn't match any known key
pub fn string_to_key(key_str: &str) -> Option<Key> {
    match key_str {
        "Alt" => Some(Key::Alt),
        "AltGr" => Some(Key::AltGr),
        "Backspace" => Some(Key::Backspace),
        "CapsLock" => Some(Key::CapsLock),
        "Ctrl" => Some(Key::ControlLeft),
        "Delete" => Some(Key::Delete),
        "↓" => Some(Key::DownArrow),
        "End" => Some(Key::End),
        "Esc" => Some(Key::Escape),
        "F1" => Some(Key::F1),
        "F2" => Some(Key::F2),
        "F3" => Some(Key::F3),
        "F4" => Some(Key::F4),
        "F5" => Some(Key::F5),
        "F6" => Some(Key::F6),
        "F7" => Some(Key::F7),
        "F8" => Some(Key::F8),
        "F9" => Some(Key::F9),
        "F10" => Some(Key::F10),
        "F11" => Some(Key::F11),
        "F12" => Some(Key::F12),
        "Home" => Some(Key::Home),
        "←" => Some(Key::LeftArrow),
        "Cmd" => Some(Key::MetaLeft),
        "PgDn" => Some(Key::PageDown),
        "PgUp" => Some(Key::PageUp),
        "Enter" => Some(Key::Return),
        "→" => Some(Key::RightArrow),
        "Shift" => Some(Key::ShiftLeft),
        "Space" => Some(Key::Space),
        "Tab" => Some(Key::Tab),
        "↑" => Some(Key::UpArrow),
        "PrtSc" => Some(Key::PrintScreen),
        "ScrollLock" => Some(Key::ScrollLock),
        "Pause" => Some(Key::Pause),
        "NumLock" => Some(Key::NumLock),
        "`" => Some(Key::BackQuote),
        "1" => Some(Key::Num1),
        "2" => Some(Key::Num2),
        "3" => Some(Key::Num3),
        "4" => Some(Key::Num4),
        "5" => Some(Key::Num5),
        "6" => Some(Key::Num6),
        "7" => Some(Key::Num7),
        "8" => Some(Key::Num8),
        "9" => Some(Key::Num9),
        "0" => Some(Key::Num0),
        "-" => Some(Key::Minus),
        "=" => Some(Key::Equal),
        "[" => Some(Key::LeftBracket),
        "]" => Some(Key::RightBracket),
        "\\" => Some(Key::BackSlash),
        ";" => Some(Key::SemiColon),
        "'" => Some(Key::Quote),
        "," => Some(Key::Comma),
        "." => Some(Key::Dot),
        "/" => Some(Key::Slash),
        "A" => Some(Key::KeyA),
        "B" => Some(Key::KeyB),
        "C" => Some(Key::KeyC),
        "D" => Some(Key::KeyD),
        "E" => Some(Key::KeyE),
        "F" => Some(Key::KeyF),
        "G" => Some(Key::KeyG),
        "H" => Some(Key::KeyH),
        "I" => Some(Key::KeyI),
        "J" => Some(Key::KeyJ),
        "K" => Some(Key::KeyK),
        "L" => Some(Key::KeyL),
        "M" => Some(Key::KeyM),
        "N" => Some(Key::KeyN),
        "O" => Some(Key::KeyO),
        "P" => Some(Key::KeyP),
        "Q" => Some(Key::KeyQ),
        "R" => Some(Key::KeyR),
        "S" => Some(Key::KeyS),
        "T" => Some(Key::KeyT),
        "U" => Some(Key::KeyU),
        "V" => Some(Key::KeyV),
        "W" => Some(Key::KeyW),
        "X" => Some(Key::KeyX),
        "Y" => Some(Key::KeyY),
        "Z" => Some(Key::KeyZ),
        "Ins" => Some(Key::Insert),
        _ => None,
    }
}

/// Converts an `rdev::Button` to its string representation
pub fn button_to_string(button: Button) -> String {
    match button {
        Button::Left => "Left".to_string(),
        Button::Right => "Right".to_string(),
        Button::Middle => "Middle".to_string(),
        Button::Unknown(code) => format!("Unknown({})", code),
    }
}

/// Converts a string representation back to an `rdev::Button`
/// Returns `None` if the string doesn't match any known button
pub fn string_to_button(button_str: &str) -> Option<Button> {
    match button_str {
        "Left" => Some(Button::Left),
        "Right" => Some(Button::Right),
        "Middle" => Some(Button::Middle),
        _ => None,
    }
}

/// Checks if a key is a modifier key (Shift, Ctrl, Alt, Cmd)
pub fn is_modifier_key(key: Key) -> bool {
    matches!(
        key,
        Key::ShiftLeft
            | Key::ShiftRight
            | Key::ControlLeft
            | Key::ControlRight
            | Key::Alt
            | Key::AltGr
            | Key::MetaLeft
            | Key::MetaRight
    )
}

/// Attempts to produce a human-readable string for a key pressed with modifiers.
/// Returns `None` when no modifiers are active.
pub fn get_character_with_modifiers(key: Key, modifiers: &std::collections::HashSet<Key>) -> Option<String> {
    if modifiers.is_empty() {
        return None;
    }

    let has_shift = modifiers.contains(&Key::ShiftLeft) || modifiers.contains(&Key::ShiftRight);
    let has_ctrl = modifiers.contains(&Key::ControlLeft) || modifiers.contains(&Key::ControlRight);
    let has_alt = modifiers.contains(&Key::Alt) || modifiers.contains(&Key::AltGr);
    let has_cmd = modifiers.contains(&Key::MetaLeft) || modifiers.contains(&Key::MetaRight);

    // Single-modifier combinations
    if has_shift && !has_ctrl && !has_alt && !has_cmd {
        return shift_combo(key);
    }
    if has_ctrl && !has_shift && !has_alt && !has_cmd {
        return single_modifier_combo("Ctrl", key);
    }
    if has_alt && !has_shift && !has_ctrl && !has_cmd {
        return single_modifier_combo("Alt", key);
    }
    if has_cmd && !has_shift && !has_ctrl && !has_alt {
        return single_modifier_combo("Cmd", key);
    }

    // Multiple modifier combinations
    let mut modifier_names = Vec::new();
    if has_shift { modifier_names.push("Shift"); }
    if has_ctrl { modifier_names.push("Ctrl"); }
    if has_alt { modifier_names.push("Alt"); }
    if has_cmd { modifier_names.push("Cmd"); }

    if modifier_names.len() > 1 {
        let key_str = key_to_string(key);
        Some(format!("{}+{}", modifier_names.join("+"), key_str))
    } else {
        None
    }
}

fn shift_combo(key: Key) -> Option<String> {
    match key {
        Key::Num1 => Some("!".to_string()),
        Key::Num2 => Some("@".to_string()),
        Key::Num3 => Some("#".to_string()),
        Key::Num4 => Some("$".to_string()),
        Key::Num5 => Some("%".to_string()),
        Key::Num6 => Some("^".to_string()),
        Key::Num7 => Some("&".to_string()),
        Key::Num8 => Some("*".to_string()),
        Key::Num9 => Some("(".to_string()),
        Key::Num0 => Some(")".to_string()),
        Key::Minus => Some("_".to_string()),
        Key::Equal => Some("+".to_string()),
        Key::LeftBracket => Some("{".to_string()),
        Key::RightBracket => Some("}".to_string()),
        Key::BackSlash | Key::IntlBackslash => Some("|".to_string()),
        Key::SemiColon => Some(":".to_string()),
        Key::Quote => Some("\"".to_string()),
        Key::BackQuote => Some("~".to_string()),
        Key::Comma => Some("<".to_string()),
        Key::Dot => Some(">".to_string()),
        Key::Slash => Some("?".to_string()),
        Key::KeyA => Some("A".to_string()),
        Key::KeyB => Some("B".to_string()),
        Key::KeyC => Some("C".to_string()),
        Key::KeyD => Some("D".to_string()),
        Key::KeyE => Some("E".to_string()),
        Key::KeyF => Some("F".to_string()),
        Key::KeyG => Some("G".to_string()),
        Key::KeyH => Some("H".to_string()),
        Key::KeyI => Some("I".to_string()),
        Key::KeyJ => Some("J".to_string()),
        Key::KeyK => Some("K".to_string()),
        Key::KeyL => Some("L".to_string()),
        Key::KeyM => Some("M".to_string()),
        Key::KeyN => Some("N".to_string()),
        Key::KeyO => Some("O".to_string()),
        Key::KeyP => Some("P".to_string()),
        Key::KeyQ => Some("Q".to_string()),
        Key::KeyR => Some("R".to_string()),
        Key::KeyS => Some("S".to_string()),
        Key::KeyT => Some("T".to_string()),
        Key::KeyU => Some("U".to_string()),
        Key::KeyV => Some("V".to_string()),
        Key::KeyW => Some("W".to_string()),
        Key::KeyX => Some("X".to_string()),
        Key::KeyY => Some("Y".to_string()),
        Key::KeyZ => Some("Z".to_string()),
        _ => None,
    }
}

fn single_modifier_combo(modifier: &str, key: Key) -> Option<String> {
    let key_str = key_to_string(key);
    // Only produce combo strings for letter keys and common targets
    match key {
        Key::KeyA | Key::KeyB | Key::KeyC | Key::KeyD | Key::KeyE |
        Key::KeyF | Key::KeyG | Key::KeyH | Key::KeyI | Key::KeyJ |
        Key::KeyK | Key::KeyL | Key::KeyM | Key::KeyN | Key::KeyO |
        Key::KeyP | Key::KeyQ | Key::KeyR | Key::KeyS | Key::KeyT |
        Key::KeyU | Key::KeyV | Key::KeyW | Key::KeyX | Key::KeyY |
        Key::KeyZ => Some(format!("{}+{}", modifier, key_str)),
        _ => None,
    }
}

