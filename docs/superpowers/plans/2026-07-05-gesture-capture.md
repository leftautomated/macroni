# Space-Switch & Swipe Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture Space/fullscreen-app switches as first-class `SpaceSwitch` events (any cause — 3-finger swipe, ⌃arrows) and replay them correctly; label in-app two-finger swipes on the Studio timeline; pause the perception UI in the Studio behind a flag. Spec: `docs/superpowers/specs/2026-07-05-gesture-capture-design.md`.

**Architecture:** An `NSWorkspace.activeSpaceDidChangeNotification` observer (native glue in `space_watch.rs`) reads the ordered space list via private CGS calls and feeds `SpaceSwitch { direction, count }` into the existing event channel. Pure logic (snapshot diffing, keyboard-trigger dedup) lives in `space_switch.rs`, fully unit-tested. Replay compiles `SpaceSwitch` into ⌃arrow key sequences through the existing simulator seam. Swipe labeling is frontend-only over existing scroll groups.

**Tech Stack:** Rust (objc2-app-kit NSWorkspace + block2, core-foundation for CGS parsing), rdev replay, React/vitest frontend.

## Global Constraints

- **Accuracy is binding:** direction/count come only from space-list index deltas — on any ambiguity (CGS failure, space not found, delta 0) emit NOTHING and `log_warn`; never a guessed direction.
- **macOS only:** all native/new capture code `#[cfg(target_os = "macos")]`; non-macOS builds compile unchanged.
- **Private API risk pinned:** `CGSMainConnectionID` / `CGSCopyManagedDisplaySpaces` (AltTab/yabai precedent). Failure degrades to "no SpaceSwitch events".
- **Dedup rule (exact):** drop a `SpaceSwitch` arriving within **500 ms** (boundary: `ts - trigger < 500` suppresses; `== 500` admits) after a captured trigger: KeyPress of `"←"`/`"→"` while Ctrl is down, or KeyPress `"F3"`. Nothing else suppresses.
- **Replay precondition (documented, not enforced):** stock ⌃←/⌃→ Mission Control shortcuts enabled.
- **Backward compatible:** `InputEvent` gains one variant; legacy recordings load unchanged.
- **In-app swipe replay unchanged** (raw scrolls); recognition is display-only. Label "Swipe ←/→" only when `|ΣdeltaX| ≥ 3×|ΣdeltaY|` AND group duration ≤ 400 ms AND `|ΣdeltaX| ≥ 120` (deltas are PIXELS — the leftautomated/rdev pixel-scroll-deltas fork captures pixel precision; legacy line-unit thinking would set this 10× too low).
- Key-name canon (from `key_mapping.rs`): Ctrl = `"Ctrl"`, arrows = `"←"` / `"→"`; `string_to_key("←") = Key::LeftArrow`, `string_to_key("Ctrl") = Key::ControlLeft`.
- Checks: `cargo test` + `cargo fmt --all` + `cargo clippy --all-targets -- -D warnings` (pre-existing permissions.rs:1437 error is exempt); `pnpm vitest run src`, `pnpm typecheck`, `pnpm lint:fix`. Frontend style = existing files (double quotes, semicolons).

## File Structure

- `src-tauri/src/space_switch.rs` (NEW) — pure: `Direction`, `SpaceSnapshot`, `diff_snapshots`, `SwitchDedup`. Fully tested, cross-platform.
- `src-tauri/src/space_watch.rs` (NEW, macOS) — CGS externs + parsing, NSWorkspace observer. Coverage-excluded native glue.
- `src-tauri/src/types.rs` — `SpaceSwitch` variant + timestamp arm.
- `src-tauri/src/playback/plan.rs` — compile SpaceSwitch → ⌃arrow steps.
- `src-tauri/src/lib.rs` — watcher install, collector dedup, mods.
- `src-tauri/Cargo.toml` — `block2` (macOS section). `.github/workflows/test.yml` — exclusion regex.
- `src/types.ts`, `src/lib/event-utils.tsx` (+test), `src/components/studio/StudioTimeline.tsx` (+test), `src/components/studio/StudioEditor.tsx` (+test).

---

### Task 1: `SpaceSwitch` event variant + TS mirror

**Files:**
- Modify: `src-tauri/src/types.rs`, `src/types.ts`
- Test: `#[cfg(test)]` additions in `types.rs` (create the module — types.rs has none)

**Interfaces (Produces):** `InputEvent::SpaceSwitch { direction: String, count: u32, timestamp: i64 }` (serde tag `"type"`, PascalCase like siblings); TS `InputEventType.SpaceSwitch` + union member `{ type: InputEventType.SpaceSwitch; direction: "left" | "right"; count: number; timestamp: number }`.

- [ ] **Step 1: Failing tests** — append to `types.rs` (new `#[cfg(test)] mod tests` at file end):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn space_switch_serde_round_trips_with_house_tagging() {
        let ev = InputEvent::SpaceSwitch {
            direction: "right".into(),
            count: 2,
            timestamp: 1500,
        };
        let json = serde_json::to_string(&ev).unwrap();
        assert!(json.contains("\"type\":\"SpaceSwitch\""), "{json}");
        let back: InputEvent = serde_json::from_str(&json).unwrap();
        assert_eq!(back.timestamp(), 1500);
        assert!(matches!(back, InputEvent::SpaceSwitch { count: 2, .. }));
    }

    #[test]
    fn legacy_event_json_still_loads() {
        let json = r#"{"type":"KeyPress","key":"A","timestamp":1}"#;
        let ev: InputEvent = serde_json::from_str(json).unwrap();
        assert_eq!(ev.timestamp(), 1);
    }
}
```

- [ ] **Step 2:** `cd src-tauri && cargo test space_switch_serde` → FAIL (no variant).
- [ ] **Step 3: Implement.** Add to the `InputEvent` enum (after `Scroll`):

```rust
    /// A macOS Space / fullscreen-app switch (3-finger swipe, ⌃arrows, …),
    /// captured semantically — the gesture itself is not observable.
    SpaceSwitch {
        direction: String, // "left" | "right"
        count: u32,        // hops — a fast multi-Space swipe records 2+
        timestamp: i64,
    },
```

Add `InputEvent::SpaceSwitch { timestamp, .. } => *timestamp,` to the `InputEventTimestamp` impl. In `src/types.ts`: add `SpaceSwitch = "SpaceSwitch"` to `InputEventType` and `| { type: InputEventType.SpaceSwitch; direction: "left" | "right"; count: number; timestamp: number }` to the `InputEvent` union. `getEventDetails` in `src/lib/event-utils.tsx` must stay exhaustive — add (with the existing `Keyboard` icon):

```tsx
    case InputEventType.SpaceSwitch:
      return {
        icon: <Keyboard className="h-3 w-3" />,
        action: "Space Switch",
        value: `⇄ ${event.direction === "left" ? "←" : "→"}${event.count > 1 ? ` ×${event.count}` : ""}`,
        detail: "",
      };
```

- [ ] **Step 4:** `cargo test` → PASS; `pnpm typecheck` → PASS (fix any other non-exhaustive switches tsc reports the same way).
- [ ] **Step 5: Commit** `git add -A src-tauri/src/types.rs src/types.ts src/lib/event-utils.tsx && git commit -m "feat(events): SpaceSwitch input event"`

---

### Task 2: Pure logic — snapshot diff + dedup (`space_switch.rs`)

**Files:**
- Create: `src-tauri/src/space_switch.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod space_switch;`)

**Interfaces (Produces):**
- `pub enum Direction { Left, Right }` with `pub fn as_str(&self) -> &'static str` (`"left"`/`"right"`).
- `pub struct SpaceSnapshot { pub displays: Vec<DisplaySpaces> }`, `pub struct DisplaySpaces { pub display: String, pub ordered: Vec<u64>, pub current: u64 }`.
- `pub fn diff_snapshots(old: &SpaceSnapshot, new: &SpaceSnapshot) -> Option<(Direction, u32)>` — first display whose `current` changed; both old and new current located in the NEW ordered list; `None` on any miss or zero delta.
- `pub struct SwitchDedup` — `new(window_ms: i64)`, `note_key_press(&mut self, key: &str, ts: i64)`, `note_key_release(&mut self, key: &str)`, `admit(&mut self, ts: i64) -> bool`.

- [ ] **Step 1: Failing tests** (in-file `mod tests`):

```rust
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
        assert_eq!(diff_snapshots(&old, &snap(&[10, 20, 30, 40], 30)), Some((Direction::Right, 1)));
        assert_eq!(diff_snapshots(&old, &snap(&[10, 20, 30, 40], 40)), Some((Direction::Right, 2)));
        assert_eq!(diff_snapshots(&old, &snap(&[10, 20, 30, 40], 10)), Some((Direction::Left, 1)));
    }

    #[test]
    fn diff_never_guesses() {
        let old = snap(&[10, 20, 30], 20);
        assert_eq!(diff_snapshots(&old, &snap(&[10, 20, 30], 20)), None, "no change");
        assert_eq!(diff_snapshots(&old, &snap(&[10, 30], 30)), None, "old current gone from new list");
        assert_eq!(diff_snapshots(&old, &snap(&[10, 20, 30], 99)), None, "new current unknown");
        let two = SpaceSnapshot { displays: vec![] };
        assert_eq!(diff_snapshots(&old, &two), None, "display disappeared");
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
}
```

- [ ] **Step 2:** `cargo test space_switch` → FAIL (module missing).
- [ ] **Step 3: Implement:**

```rust
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
        let od = old.displays.iter().find(|d| d.display == nd.display)?;
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
```

Register `mod space_switch;` in lib.rs (alphabetical). Add house `#[allow(dead_code)] // consumed by Task 4 (watcher + collector)` markers if `cargo clippy --all-targets -- -D warnings` demands them.

- [ ] **Step 4:** `cargo test && cargo fmt --all && cargo clippy --all-targets -- -D warnings` (permissions.rs pre-existing error exempt) → PASS.
- [ ] **Step 5: Commit** `git commit -am "feat(events): space snapshot diff and keyboard dedup logic"`

---

### Task 3: Replay — compile `SpaceSwitch` into ⌃arrow sequences

**Files:**
- Modify: `src-tauri/src/playback/plan.rs`
- Test: existing `mod tests` in plan.rs

**Interfaces:**
- Consumes: `InputEvent::SpaceSwitch` (Task 1), `string_to_key` canon, `PlannedStep::{Simulate, Sleep}`.
- Produces: `push_simulate` emits per hop: `Simulate(KeyPress(ControlLeft))`, `Sleep 10`, `Simulate(KeyPress(<arrow>))`, `Sleep 10`, `Simulate(KeyRelease(<arrow>))`, `Sleep 10`, `Simulate(KeyRelease(ControlLeft))`, and `Sleep 150` between hops (not after the last — the compile loop's post-settle covers that).

- [ ] **Step 1: Failing test** (append in plan.rs tests, following the file's existing step-assertion style — check a neighboring test for the exact `PlannedStep` matching idiom and mirror it):

```rust
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
        assert!(plan.steps.iter().any(|s| matches!(s, PlannedStep::Sleep { ms: 150 })));
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
```

- [ ] **Step 2:** `cargo test compile_space_switch` → FAIL (non-exhaustive match / no arm).
- [ ] **Step 3: Implement** in `push_simulate` (new arm; `min_delay_for` and the KeyCombo skip are untouched — `SpaceSwitch` goes through the normal timing path):

```rust
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
                steps.push(PlannedStep::Simulate(EventType::KeyPress(rdev::Key::ControlLeft)));
                steps.push(PlannedStep::Sleep { ms: 10 });
                steps.push(PlannedStep::Simulate(EventType::KeyPress(arrow)));
                steps.push(PlannedStep::Sleep { ms: 10 });
                steps.push(PlannedStep::Simulate(EventType::KeyRelease(arrow)));
                steps.push(PlannedStep::Sleep { ms: 10 });
                steps.push(PlannedStep::Simulate(EventType::KeyRelease(rdev::Key::ControlLeft)));
            }
        }
```

(If `push_simulate`'s existing arms end with a catch-all, place this before it; if the match is exhaustive, the compiler drives placement. Import path per file conventions — `rdev::Key` may already be imported as `Key`.)

- [ ] **Step 4:** `cargo test && cargo fmt --all && cargo clippy --all-targets -- -D warnings` → PASS.
- [ ] **Step 5: Commit** `git commit -am "feat(playback): replay SpaceSwitch as ctrl-arrow sequences"`

---

### Task 4: Native watcher (`space_watch.rs`) + collector wiring

**Files:**
- Create: `src-tauri/src/space_watch.rs` (macOS-only)
- Modify: `src-tauri/src/lib.rs` (mod, watcher install, collector dedup), `src-tauri/Cargo.toml` (`block2` under macOS deps, version matching Cargo.lock's existing block2 entry), `.github/workflows/test.yml` (regex → `'(permissions|ocr_macos|space_watch)\.rs$'`)

**Interfaces:**
- Consumes: `space_switch::{diff_snapshots, SpaceSnapshot, DisplaySpaces, SwitchDedup}`, the event `Sender<InputEvent>` (clone of the collector `tx` in lib.rs setup), `Arc<RecordingSession>` (`is_active()`).
- Produces: `space_watch::install(tx: std::sync::mpsc::Sender<InputEvent>, session: Arc<RecordingSession>)` — registers the NSWorkspace observer on the main thread (call from Tauri `setup`), keeps the previous snapshot internally, sends `InputEvent::SpaceSwitch` stamped `Utc::now().timestamp_millis()` only while a session is active. Never panics: CGS/parse failures → `log_warn("space_watch", …)` + skip.

- [ ] **Step 1: Failing test first for the collector dedup wiring** — this is the CI-testable piece. The collector loop in lib.rs is glue; test the dedup at its seam by adding one test to `space_switch.rs` proving the exact event-stream protocol the collector uses:

```rust
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
```

- [ ] **Step 2:** `cargo test dedup_protocol` → FAIL (test new) → will pass once added since SwitchDedup exists; the real RED here is compile-time on the new module. Run, confirm green after adding, then proceed to the native shell.
- [ ] **Step 3: Implement `space_watch.rs`.** Contract is fixed; exact objc2/block2 spellings may need compiler-guided adjustment (same rule as ocr_macos.rs — do NOT change the `install` signature):

```rust
//! macOS Space-switch watcher: NSWorkspace notification + private CGS space
//! listing (AltTab/yabai precedent). Native glue — coverage-excluded; the
//! diffing and dedup logic it feeds is pure and tested in space_switch.rs.
//! On ANY read/parse failure: log_warn and emit nothing (never guess).

use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};

use block2::RcBlock;
use chrono::Utc;
use core_foundation::array::CFArray;
use core_foundation::base::{CFType, TCFType};
use core_foundation::dictionary::CFDictionary;
use core_foundation::number::CFNumber;
use core_foundation::string::CFString;
use objc2_app_kit::NSWorkspace;

use crate::recording_session::RecordingSession;
use crate::space_switch::{diff_snapshots, DisplaySpaces, SpaceSnapshot, SwitchDedup as _};
use crate::types::InputEvent;

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGSMainConnectionID() -> i32;
    fn CGSCopyManagedDisplaySpaces(cid: i32) -> core_foundation::array::CFArrayRef;
}

/// Read the ordered space list per display. None on any failure.
fn read_snapshot() -> Option<SpaceSnapshot> {
    unsafe {
        let raw = CGSCopyManagedDisplaySpaces(CGSMainConnectionID());
        if raw.is_null() {
            return None;
        }
        let displays: CFArray<CFDictionary<CFString, CFType>> =
            CFArray::wrap_under_create_rule(raw as _);
        let mut out = Vec::new();
        for d in displays.iter() {
            let display = d
                .find(CFString::from_static_string("Display Identifier"))?
                .downcast::<CFString>()?
                .to_string();
            let current = d
                .find(CFString::from_static_string("Current Space"))?
                .downcast::<CFDictionary<CFString, CFType>>()?
                .find(CFString::from_static_string("id64"))?
                .downcast::<CFNumber>()?
                .to_i64()? as u64;
            let spaces = d
                .find(CFString::from_static_string("Spaces"))?
                .downcast::<CFArray<CFDictionary<CFString, CFType>>>()?;
            let mut ordered = Vec::new();
            for s in spaces.iter() {
                ordered.push(
                    s.find(CFString::from_static_string("id64"))?
                        .downcast::<CFNumber>()?
                        .to_i64()? as u64,
                );
            }
            out.push(DisplaySpaces { display, ordered, current });
        }
        Some(SpaceSnapshot { displays: out })
    }
}

/// Register the active-space observer. Call once from Tauri setup (main
/// thread). The observer token intentionally lives for the app's lifetime.
pub fn install(tx: Sender<InputEvent>, session: Arc<RecordingSession>) {
    let prev = Mutex::new(read_snapshot());
    let block = RcBlock::new(move |_notif: *mut objc2_foundation::NSNotification| {
        let Some(new) = read_snapshot() else {
            crate::observability::log_warn("space_watch", "cgs_read_failed", "skipping switch", None);
            return;
        };
        let mut prev = prev.lock().unwrap();
        if let Some(old) = prev.as_ref() {
            if let Some((dir, count)) = diff_snapshots(old, &new) {
                if session.is_active() {
                    let _ = tx.send(InputEvent::SpaceSwitch {
                        direction: dir.as_str().to_string(),
                        count,
                        timestamp: Utc::now().timestamp_millis(),
                    });
                }
            }
        }
        *prev = Some(new);
    });
    unsafe {
        let ws = NSWorkspace::sharedWorkspace();
        let nc = ws.notificationCenter();
        let token = nc.addObserverForName_object_queue_usingBlock(
            Some(objc2_app_kit::NSWorkspaceActiveSpaceDidChangeNotification),
            None,
            None,
            &block,
        );
        std::mem::forget(token); // app-lifetime observer
    }
}
```

(The `SwitchDedup as _` import is wrong-by-design above — remove it; dedup lives in the collector, not the watcher. The `downcast` calls: core-foundation 0.10's API is `.downcast::<T>()` on `CFType` via `TCFType`; if the compiler disagrees, use `CFDictionary::<CFString, CFType>` accessors + `wrap_under_get_rule` per its docs — the *shape* (find key → typed value → build `DisplaySpaces`) is the contract.)

- [ ] **Step 4: Wire lib.rs.** Add `mod space_watch;` under `#[cfg(target_os = "macos")]` and `mod space_switch;` (Task 2 did). In setup, before the collector thread: `let space_tx = tx.clone();` and after the listener spawn (macOS only):

```rust
            #[cfg(target_os = "macos")]
            space_watch::install(space_tx, Arc::clone(&collector_session_for_watch));
```

(clone another `Arc` off `state.session` next to the existing clones). Collector thread gains the dedup:

```rust
            let mut dedup = space_switch::SwitchDedup::new(500);
            std::thread::spawn(move || {
                while let Ok(event) = rx.recv() {
                    match &event {
                        InputEvent::KeyPress { key, timestamp } => {
                            dedup.note_key_press(key, *timestamp)
                        }
                        InputEvent::KeyRelease { key, .. } => dedup.note_key_release(key),
                        InputEvent::SpaceSwitch { timestamp, .. } => {
                            if !dedup.admit(*timestamp) {
                                continue; // ⌃arrow already recorded this switch
                            }
                        }
                        _ => {}
                    }
                    collector_session.push_event(event);
                }
            });
```

Add `block2 = "<version from Cargo.lock>"` to the macOS dependency section and update the CI coverage regex in `.github/workflows/test.yml` to `'(permissions|ocr_macos|space_watch)\.rs$'`.

- [ ] **Step 5:** `cargo build && cargo test && cargo fmt --all && cargo clippy --all-targets -- -D warnings` → PASS (iterate on objc2/CF spellings until build is clean; permissions.rs pre-existing exempt).
- [ ] **Step 6: Manual smoke (required, cannot be CI'd):** `pnpm tauri dev` → record → 3-finger swipe right, wait, swipe left, wait, fast double-swipe right, then a ⌃→ keyboard switch → stop. Inspect the saved recording's events (`jq '.[-1].events[] | select(.type=="SpaceSwitch")' recordings.json`): expect right×1, left×1, right×2 (or two right×1 if the notification fired twice — both acceptable), and exactly NO SpaceSwitch for the keyboard switch. Replay the recording and confirm you end on the correct Space. Record results in the task report.
- [ ] **Step 7: Commit** `git commit -am "feat(capture): macos space-switch watcher with keyboard dedup"`

---

### Task 5: Studio timeline ⇄ marker

**Files:**
- Modify: `src/components/studio/StudioTimeline.tsx`
- Test: `src/components/studio/StudioTimeline.test.tsx`

**Interfaces:** Consumes `InputEventType.SpaceSwitch` rows (kind `"event"` from `groupEvents`) and `getEventDetails` (Task 1). Produces: SpaceSwitch ticks on the keys lane, color `#f472b6`, tooltip via `getEventDetails` value; legend gains `{ c: "#f472b6", l: "Space" }`.

- [ ] **Step 1: Failing test:**

```tsx
  it("renders a space-switch tick on the keys lane with direction tooltip", () => {
    const evs: InputEvent[] = [
      { type: InputEventType.SpaceSwitch, direction: "right", count: 2, timestamp: 1500 },
    ];
    const { container } = render(
      <StudioTimeline {...base} events={evs} onSeekSeconds={noop} onLoopChange={noop} />,
    );
    const tick = container.querySelector('[title*="⇄ →"][title*="×2"]');
    expect(tick).toBeTruthy();
    expect(screen.getByText("Space")).toBeInTheDocument(); // legend
  });
```

- [ ] **Step 2:** `pnpm vitest run src/components/studio/StudioTimeline.test.tsx` → FAIL.
- [ ] **Step 3: Implement.** In `StudioTimeline.tsx`: add `InputEventType.SpaceSwitch` to `KEY_TYPES` (puts it on the keys lane), add `space: "#f472b6"` to `COLOR`, add `{ c: COLOR.space, l: "Space" }` to the legend array. In `renderRow`'s `row.kind === "event"` branch, color space-switch ticks distinctly:

```tsx
      const color =
        row.event.type === InputEventType.SpaceSwitch
          ? COLOR.space
          : lane === "keys"
            ? COLOR.key
            : COLOR.click;
```

(the existing `title={…${d.action}${d.value…}}` already renders "Space Switch ⇄ → ×2" via Task 1's `getEventDetails`).

- [ ] **Step 4:** `pnpm vitest run src && pnpm typecheck && pnpm lint:fix` → PASS.
- [ ] **Step 5: Commit** `git commit -am "feat(studio): space-switch markers on the timeline"`

---

### Task 6: Swipe labeling for scroll groups

**Files:**
- Modify: `src/lib/event-utils.tsx`, `src/components/studio/StudioTimeline.tsx`
- Test: `src/lib/event-utils.test.tsx`

**Interfaces (Produces):**
- Scroll `EventRow` gains `endTimestamp: number` (set to `timestamp` at creation, updated on every merge).
- `export function swipeLabel(row: Extract<EventRow, { kind: "scroll" }>): string | null` — `"Swipe →"` / `"Swipe ←"` per the Global Constraints thresholds (`|ΣdeltaX| ≥ 3×|ΣdeltaY|`, duration = `endTimestamp - timestamp ≤ 400`, `|ΣdeltaX| ≥ 30`), else `null`.

- [ ] **Step 1: Failing tests** (event-utils.test.tsx; build events with a small helper):

```tsx
const scroll = (dx: number, dy: number, t: number): InputEvent => ({
  type: InputEventType.Scroll,
  delta_x: dx,
  delta_y: dy,
  timestamp: t,
});

describe("swipeLabel", () => {
  it("labels a fast horizontal fling as a swipe", () => {
    const rows = groupEvents([scroll(80, 5, 0), scroll(90, -4, 80), scroll(60, 0, 160)]);
    expect(rows).toHaveLength(1);
    const row = rows[0] as Extract<EventRow, { kind: "scroll" }>;
    expect(swipeLabel(row)).toBe("Swipe →");
  });

  it("labels direction from the sign", () => {
    const rows = groupEvents([scroll(-160, 0, 0), scroll(-120, 8, 100)]);
    expect(swipeLabel(rows[0] as Extract<EventRow, { kind: "scroll" }>)).toBe("Swipe ←");
  });

  it("rejects diagonal scrolls, slow pans, and small jiggles", () => {
    // Diagonal: vertical too large relative to horizontal.
    const diag = groupEvents([scroll(120, 80, 0), scroll(120, 60, 100)]);
    expect(swipeLabel(diag[0] as Extract<EventRow, { kind: "scroll" }>)).toBeNull();
    // Slow: same deltas over 900ms.
    const slow = groupEvents([scroll(120, 0, 0), scroll(120, 4, 900)]);
    expect(swipeLabel(slow[0] as Extract<EventRow, { kind: "scroll" }>)).toBeNull();
    // Tiny: under the 120px floor.
    const tiny = groupEvents([scroll(40, 0, 0), scroll(50, 0, 50)]);
    expect(swipeLabel(tiny[0] as Extract<EventRow, { kind: "scroll" }>)).toBeNull();
  });
});
```

- [ ] **Step 2:** `pnpm vitest run src/lib/event-utils.test.tsx` → FAIL.
- [ ] **Step 3: Implement.** In the scroll branch of `groupEvents`: add `endTimestamp: event.timestamp` at row creation and `last.endTimestamp = event.timestamp;` in the merge arm (and add the field to the `EventRow` scroll variant type). Then:

```tsx
/**
 * Conservative swipe recognition over a scroll group: decisively horizontal
 * (≥3× vertical), a fling (≤400ms), and above a 120px magnitude floor (deltas are pixels — rdev fork). Borderline
 * cases stay "Scroll" — a false "Swipe" label is the failure mode that
 * matters. Display-only: replay always uses the raw scroll events.
 */
export function swipeLabel(row: Extract<EventRow, { kind: "scroll" }>): string | null {
  const ax = Math.abs(row.deltaX);
  if (ax < 120) return null;
  if (ax < 3 * Math.abs(row.deltaY)) return null;
  if (row.endTimestamp - row.timestamp > 400) return null;
  return row.deltaX > 0 ? "Swipe →" : "Swipe ←";
}
```

In `StudioTimeline.tsx`'s scroll-span rendering, prefer the swipe label: where `info`/`label` are computed for `row.kind === "scroll"`, use `const sw = swipeLabel(row);` → `label = sw ?? "Scroll"`, `info = sw ? `${sw} (${scrollSummary(...)})` : `Scroll ${scrollSummary(...)}``.

- [ ] **Step 4:** `pnpm vitest run src && pnpm typecheck && pnpm lint:fix` → PASS.
- [ ] **Step 5: Commit** `git commit -am "feat(studio): label horizontal flings as swipes"`

---

### Task 7: Pause perception UI in the Studio

**Files:**
- Modify: `src/components/studio/StudioEditor.tsx`, `src/components/studio/StudioPlayer.tsx`
- Test: `src/components/studio/StudioEditor.test.tsx` (or create `PerceptionGate.test.tsx` assertions inside the existing editor test file)

**Interfaces:**
- `const PERCEPTION_STUDIO_UI = false;` module const in `StudioEditor.tsx` with a comment pointing at the pending annotation-UX redesign.
- When false: the observations effect does not invoke `load_observations`; `perceptionTicks`/`playheadSpans` stay empty; `StudioPlayer` gets NO `targets`/`spans`/`hasObservations`/`onSaveTarget`/`onSampleColor` props; `PerceptionPanel` never renders.
- `StudioPlayer`: when `onSaveTarget` is absent, a completed drag clears the selection without opening the popover (click-to-toggle-play unaffected). Everything else (backend, settings toggle, components, component tests) untouched.

- [ ] **Step 1: Failing tests.** Editor test (mock pattern already in the file): render with a recording that HAS `targets` → assert no perception panel content (e.g. no "Test frame" button) and `invoke` never called with `"load_observations"`. Player test: render with `onSaveTarget` undefined, drag past threshold on `.sp-interact`, assert no Save button appears and the dashed selection box is gone after pointer-up.

```tsx
  // StudioPlayer.test.tsx
  it("drag without onSaveTarget is inert (perception UI paused)", () => {
    const { container } = render(
      <StudioPlayer src="asset://clip.mp4" fps={30} onTimeUpdate={noop} onReplay={noop} />,
    );
    const layer = container.querySelector(".sp-interact") as HTMLElement;
    fireEvent.pointerDown(layer, { clientX: 30, clientY: 20, pointerId: 1 });
    fireEvent.pointerMove(layer, { clientX: 60, clientY: 45, pointerId: 1 });
    fireEvent.pointerUp(layer, { clientX: 60, clientY: 45, pointerId: 1 });
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    expect(container.querySelector('[style*="dashed"]')).toBeNull();
  });
```

- [ ] **Step 2:** Run both test files → FAIL (popover currently opens regardless).
- [ ] **Step 3: Implement.** StudioPlayer `handlePointerUp` moved-branch: `if (!onSaveTarget) { setSelection(null); return; }` before opening the popover. StudioEditor: add the const + gate the observations effect (`if (!PERCEPTION_STUDIO_UI || !selectedId) return;` after the reset), the memos (return `[]` when off), the player props (spread conditionally: `{...(PERCEPTION_STUDIO_UI ? { targets: selected.targets ?? [], spans: playheadSpans, hasObservations: observations.length > 0, onSaveTarget: handleSaveTarget, onSampleColor: handleSampleColor } : {})}`), the `perceptionTicks` prop (`PERCEPTION_STUDIO_UI ? perceptionTicks : undefined`), and the `PerceptionPanel` render condition (`PERCEPTION_STUDIO_UI && …`).
- [ ] **Step 4:** `pnpm vitest run src && pnpm typecheck && pnpm lint:fix` → PASS (all perception component tests still green — they test components directly).
- [ ] **Step 5: Commit** `git commit -am "feat(studio): pause perception ui behind a flag pending redesign"`

---

## Spec-coverage checklist (self-review)

- SpaceSwitch data model + backward compat → Task 1. Snapshot diff accuracy rules + dedup window/boundary → Task 2 (exact 500ms boundary test). Replay ⌃arrows + inter-hop pause + precondition comment → Task 3. Observer + CGS + collector wiring + CI exclusion + manual smoke protocol → Task 4. Timeline ⇄ + legend → Task 5. Swipe thresholds (3×, 400ms, 120px floor) + rejection tests + display-only → Task 6. Perception UI flag scope → Task 7.
- Type consistency verified: `direction: String("left"|"right")`/`count: u32` used identically in Tasks 1/3/4; key canon `"Ctrl"`/`"←"`/`"→"` in Tasks 2/4 matches `key_mapping.rs`; `endTimestamp` defined and consumed in Task 6 only.
- Known plan-level caveat (mirrors ocr_macos precedent): Task 4's objc2/core-foundation spellings are compiler-resolved; the `install` signature and read→diff→send shape are the contract.
