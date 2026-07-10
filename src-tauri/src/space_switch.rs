//! Pure logic for Space-switch capture: snapshot diffing (direction/count
//! from space ordering — never guessed) and keyboard-trigger dedup (a
//! ⌃arrow-initiated switch already replays via its key events; the
//! NSWorkspace notification would double it). Native glue is in space_watch.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    Left,
    Right,
}

impl Direction {
    pub fn as_str(&self) -> &'static str {
        match self {
            Direction::Left => "left",
            Direction::Right => "right",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct DisplaySpaces {
    pub display: String,
    pub ordered: Vec<u64>,
    pub current: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SpaceSnapshot {
    pub displays: Vec<DisplaySpaces>,
}

/// Direction and hop count for the first display whose current space changed.
/// Both indices are located in the NEW ordered list (spaces can be created or
/// destroyed between snapshots). Any ambiguity → None: accuracy rule — never
/// emit a guessed direction.
pub fn diff_snapshots(old: &SpaceSnapshot, new: &SpaceSnapshot) -> Option<(Direction, u32)> {
    for nd in &new.displays {
        let Some(od) = old.displays.iter().find(|d| d.display == nd.display) else {
            continue; // unknown display — irrelevant to other displays' changes
        };
        if od.current == nd.current {
            continue;
        }
        let old_idx = nd.ordered.iter().position(|id| *id == od.current)?;
        let new_idx = nd.ordered.iter().position(|id| *id == nd.current)?;
        return match new_idx as i64 - old_idx as i64 {
            0 => None,
            d if d < 0 => Some((Direction::Left, (-d) as u32)),
            d => Some((Direction::Right, d as u32)),
        };
    }
    None
}

/// Drops SpaceSwitch events that a captured keyboard trigger already explains.
/// Triggers: "←"/"→" KeyPress while Ctrl is held, or "F3" (Mission Control).
pub struct SwitchDedup {
    window_ms: i64,
    ctrl_down: bool,
    last_trigger: Option<i64>,
}

impl SwitchDedup {
    pub fn new(window_ms: i64) -> Self {
        Self {
            window_ms,
            ctrl_down: false,
            last_trigger: None,
        }
    }

    pub fn note_key_press(&mut self, key: &str, ts: i64) {
        match key {
            "Ctrl" => self.ctrl_down = true,
            "←" | "→" if self.ctrl_down => self.last_trigger = Some(ts),
            "F3" => self.last_trigger = Some(ts),
            _ => {}
        }
    }

    pub fn note_key_release(&mut self, key: &str) {
        if key == "Ctrl" {
            self.ctrl_down = false;
        }
    }

    /// True when a SpaceSwitch stamped `ts` should be recorded.
    pub fn admit(&mut self, ts: i64) -> bool {
        match self.last_trigger {
            Some(t) => ts.saturating_sub(t) >= self.window_ms,
            None => true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snap(ordered: &[u64], current: u64) -> SpaceSnapshot {
        SpaceSnapshot {
            displays: vec![DisplaySpaces {
                display: "main".into(),
                ordered: ordered.to_vec(),
                current,
            }],
        }
    }

    #[test]
    fn diff_derives_direction_and_count_from_ordering() {
        let old = snap(&[10, 20, 30, 40], 20);
        assert_eq!(
            diff_snapshots(&old, &snap(&[10, 20, 30, 40], 30)),
            Some((Direction::Right, 1))
        );
        assert_eq!(
            diff_snapshots(&old, &snap(&[10, 20, 30, 40], 40)),
            Some((Direction::Right, 2))
        );
        assert_eq!(
            diff_snapshots(&old, &snap(&[10, 20, 30, 40], 10)),
            Some((Direction::Left, 1))
        );
    }

    #[test]
    fn diff_never_guesses() {
        let old = snap(&[10, 20, 30], 20);
        assert_eq!(
            diff_snapshots(&old, &snap(&[10, 20, 30], 20)),
            None,
            "no change"
        );
        assert_eq!(
            diff_snapshots(&old, &snap(&[10, 30], 30)),
            None,
            "old current gone from new list"
        );
        assert_eq!(
            diff_snapshots(&old, &snap(&[10, 20, 30], 99)),
            None,
            "new current unknown"
        );
        let two = SpaceSnapshot { displays: vec![] };
        assert_eq!(diff_snapshots(&old, &two), None, "display disappeared");
    }

    #[test]
    fn diff_skips_unknown_displays_and_still_resolves_others() {
        // A display that didn't exist in the old snapshot (monitor plugged in
        // mid-poll) must not abort the scan for the display that DID change.
        let old = SpaceSnapshot {
            displays: vec![DisplaySpaces {
                display: "main".into(),
                ordered: vec![10, 20, 30],
                current: 20,
            }],
        };
        let new = SpaceSnapshot {
            displays: vec![
                DisplaySpaces {
                    display: "external".into(),
                    ordered: vec![77],
                    current: 77,
                },
                DisplaySpaces {
                    display: "main".into(),
                    ordered: vec![10, 20, 30],
                    current: 30,
                },
            ],
        };
        assert_eq!(diff_snapshots(&old, &new), Some((Direction::Right, 1)));
    }

    #[test]
    fn dedup_suppresses_only_recent_ctrl_arrow_or_f3_triggers() {
        let mut d = SwitchDedup::new(500);
        assert!(d.admit(1_000), "no trigger yet");
        // Arrow WITHOUT ctrl is not a trigger.
        d.note_key_press("←", 2_000);
        assert!(d.admit(2_100));
        // Ctrl-held arrow is a trigger.
        d.note_key_press("Ctrl", 3_000);
        d.note_key_press("←", 3_010);
        assert!(!d.admit(3_100), "within window");
        assert!(!d.admit(3_509), "3_010 + 499 still suppressed");
        assert!(d.admit(3_510), "boundary: exactly window admits");
        // Releasing ctrl ends trigger arming.
        d.note_key_release("Ctrl");
        d.note_key_press("→", 4_000);
        assert!(d.admit(4_050));
        // F3 (Mission Control) triggers regardless of ctrl.
        d.note_key_press("F3", 5_000);
        assert!(!d.admit(5_400));
    }

    #[test]
    fn direction_as_str_is_the_wire_form() {
        // as_str feeds SpaceSwitch.direction, which the TS mirror and replay
        // (Task 3) match on as "left"/"right" — pin the exact strings.
        assert_eq!(Direction::Left.as_str(), "left");
        assert_eq!(Direction::Right.as_str(), "right");
    }

    #[test]
    fn dedup_protocol_matches_collector_usage() {
        // The lib.rs collector feeds every KeyPress/KeyRelease into the dedup
        // and gates SpaceSwitch on admit(). A ⌃→ press then a notification
        // 80ms later must record exactly the key events, not the switch.
        let mut d = SwitchDedup::new(500);
        d.note_key_press("Ctrl", 1_000);
        d.note_key_press("→", 1_020);
        assert!(!d.admit(1_100), "notification explained by the keys");
        d.note_key_release("→");
        d.note_key_release("Ctrl");
        // A gesture switch 2s later (no keys) records.
        assert!(d.admit(3_100));
    }
}
