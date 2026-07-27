//! Active recording lifecycle. Replaces the loose
//! `is_recording`/`current_events`/`current_id`/`capture_session` fields on
//! `RecordingState` with a single state machine that enforces the invariant
//! "active iff id and event buffer exist together."
//!
//! Hot path: the rdev listener thread reads `is_active()` thousands of times
//! per second; that read is an `AtomicBool::load` and never touches the inner
//! mutex. The mutex only serializes start/stop transitions and event pushes,
//! both of which are far less frequent.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use crate::capture::ScreenCaptureSession;
use crate::types::{InputEvent, InputEventTimestamp};

pub struct RecordingSession {
    recording: AtomicBool,
    inner: Mutex<SessionState>,
}

enum SessionState {
    Idle,
    Active {
        id: String,
        events: Vec<InputEvent>,
        capture: Option<ScreenCaptureSession>,
        perception: Option<crate::perception::worker::PerceptionWorker>,
    },
}

/// Snapshot of an active session at the moment `stop()` was called.
pub struct StoppedSession {
    pub id: String,
    pub events: Vec<InputEvent>,
    pub capture: Option<ScreenCaptureSession>,
    pub perception: Option<crate::perception::worker::PerceptionWorker>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum SessionError {
    AlreadyActive,
    NotActive,
}

#[derive(Debug)]
enum OpenInput {
    Key(String),
    Button { button: String, x: f64, y: f64 },
}

#[cfg(any(target_os = "linux", test))]
const X11_AUTOREPEAT_PAIR_MAX_MS: i64 = 5;

/// X11 normally represents autorepeat as a synthetic release immediately
/// followed by another press. Collapse that pair after capture so recordings
/// retain the physical down state. See XKB DetectableAutorepeat:
/// https://www.x.org/releases/X11R7.7/doc/libX11/XKB/xkblib.html
#[cfg(any(target_os = "linux", test))]
fn collapse_x11_autorepeat_pairs(events: &mut Vec<InputEvent>) {
    let mut normalized = Vec::with_capacity(events.len());
    let mut iter = std::mem::take(events).into_iter().peekable();
    while let Some(event) = iter.next() {
        let repeat = match (&event, iter.peek()) {
            (
                InputEvent::KeyRelease {
                    key: released_key,
                    timestamp: released_at,
                },
                Some(InputEvent::KeyPress {
                    key: pressed_key,
                    timestamp: pressed_at,
                }),
            ) if released_key == pressed_key
                && (0..=X11_AUTOREPEAT_PAIR_MAX_MS)
                    .contains(&pressed_at.saturating_sub(*released_at)) =>
            {
                Some((pressed_key.clone(), *pressed_at))
            }
            _ => None,
        };

        let Some((key, timestamp)) = repeat else {
            normalized.push(event);
            continue;
        };
        let Some(InputEvent::KeyPress { .. }) = iter.next() else {
            normalized.push(event);
            continue;
        };
        normalized.push(InputEvent::KeyRepeat {
            key: key.clone(),
            timestamp,
        });
        if matches!(
            iter.peek(),
            Some(InputEvent::KeyCombo {
                key: combo_key,
                timestamp: combo_at,
                ..
            }) if combo_key == &key && *combo_at == timestamp
        ) {
            iter.next();
        }
    }
    *events = normalized;
}

fn close_open_inputs(events: &mut Vec<InputEvent>, stopped_at: i64) {
    let mut open = Vec::<OpenInput>::new();
    for event in events.iter() {
        match event {
            InputEvent::KeyPress { key, .. } => {
                if !open
                    .iter()
                    .any(|input| matches!(input, OpenInput::Key(open_key) if open_key == key))
                {
                    open.push(OpenInput::Key(key.clone()));
                }
            }
            InputEvent::KeyRepeat { .. } => {}
            InputEvent::KeyRelease { key, .. } => {
                if let Some(index) = open
                    .iter()
                    .rposition(|input| matches!(input, OpenInput::Key(open_key) if open_key == key))
                {
                    open.remove(index);
                }
            }
            InputEvent::ButtonPress { button, x, y, .. } => {
                if !open.iter().any(
                    |input| matches!(input, OpenInput::Button { button: open_button, .. } if open_button == button),
                ) {
                    open.push(OpenInput::Button {
                        button: button.clone(),
                        x: *x,
                        y: *y,
                    });
                }
            }
            InputEvent::ButtonRelease { button, .. } => {
                if let Some(index) = open.iter().rposition(
                    |input| matches!(input, OpenInput::Button { button: open_button, .. } if open_button == button),
                ) {
                    open.remove(index);
                }
            }
            InputEvent::MouseMove { x, y, .. } => {
                for input in &mut open {
                    if let OpenInput::Button {
                        x: open_x,
                        y: open_y,
                        ..
                    } = input
                    {
                        *open_x = *x;
                        *open_y = *y;
                    }
                }
            }
            InputEvent::KeyCombo { .. }
            | InputEvent::Scroll { .. }
            | InputEvent::SpaceSwitch { .. } => {}
        }
    }

    let release_timestamp = events
        .last()
        .map_or(stopped_at, |event| stopped_at.max(event.timestamp()));
    for input in open.into_iter().rev() {
        events.push(match input {
            OpenInput::Key(key) => InputEvent::KeyRelease {
                key,
                timestamp: release_timestamp,
            },
            OpenInput::Button { button, x, y } => InputEvent::ButtonRelease {
                button,
                x,
                y,
                timestamp: release_timestamp,
            },
        });
    }
}

impl std::fmt::Display for SessionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SessionError::AlreadyActive => write!(f, "Already recording"),
            SessionError::NotActive => write!(f, "Not recording"),
        }
    }
}

impl RecordingSession {
    pub fn new() -> Self {
        Self {
            recording: AtomicBool::new(false),
            inner: Mutex::new(SessionState::Idle),
        }
    }

    /// Cheap lock-free read suitable for the listener thread's hot path.
    pub fn is_active(&self) -> bool {
        self.recording.load(Ordering::Relaxed)
    }

    pub fn start(
        &self,
        id: String,
        capture: Option<ScreenCaptureSession>,
        perception: Option<crate::perception::worker::PerceptionWorker>,
    ) -> Result<(), SessionError> {
        let mut state = self.inner.lock().map_err(|_| SessionError::AlreadyActive)?;
        if matches!(*state, SessionState::Active { .. }) {
            return Err(SessionError::AlreadyActive);
        }
        *state = SessionState::Active {
            id,
            events: Vec::new(),
            capture,
            perception,
        };
        self.recording.store(true, Ordering::Relaxed);
        Ok(())
    }

    /// Append an event to the active session. No-op when idle (covers races
    /// where in-flight events arrive after `stop`).
    pub fn push_event(&self, event: InputEvent) {
        if !self.recording.load(Ordering::Relaxed) {
            return;
        }
        if let Ok(mut state) = self.inner.lock() {
            if let SessionState::Active { events, .. } = &mut *state {
                events.push(event);
            }
        }
    }

    /// Stop the active session and return its id, accumulated events, and
    /// (still-running) capture. Returns `NotActive` when idle.
    pub fn stop(&self) -> Result<StoppedSession, SessionError> {
        // Flip the hot-path flag first so any racing push_event becomes a
        // no-op before we move the state.
        self.recording.store(false, Ordering::Relaxed);
        let mut state = self.inner.lock().map_err(|_| SessionError::NotActive)?;
        match std::mem::replace(&mut *state, SessionState::Idle) {
            SessionState::Active {
                id,
                mut events,
                capture,
                perception,
            } => {
                #[cfg(target_os = "linux")]
                collapse_x11_autorepeat_pairs(&mut events);
                close_open_inputs(&mut events, chrono::Utc::now().timestamp_millis());
                Ok(StoppedSession {
                    id,
                    events,
                    capture,
                    perception,
                })
            }
            SessionState::Idle => Err(SessionError::NotActive),
        }
    }

    /// Read-only snapshot of the current session id while active.
    #[allow(dead_code)]
    pub fn current_id(&self) -> Option<String> {
        let state = self.inner.lock().ok()?;
        match &*state {
            SessionState::Active { id, .. } => Some(id.clone()),
            SessionState::Idle => None,
        }
    }
}

impl Default for RecordingSession {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::InputEventTimestamp;

    fn ev(ts: i64) -> InputEvent {
        InputEvent::Scroll {
            delta_x: 0,
            delta_y: 0,
            timestamp: ts,
        }
    }

    #[test]
    fn new_session_is_idle() {
        let s = RecordingSession::new();
        assert!(!s.is_active());
        assert_eq!(s.current_id(), None);
    }

    #[test]
    fn start_makes_session_active() {
        let s = RecordingSession::new();
        s.start("rec-1".into(), None, None).unwrap();
        assert!(s.is_active());
        assert_eq!(s.current_id(), Some("rec-1".into()));
    }

    #[test]
    fn double_start_errors() {
        let s = RecordingSession::new();
        s.start("rec-1".into(), None, None).unwrap();
        assert_eq!(
            s.start("rec-2".into(), None, None),
            Err(SessionError::AlreadyActive)
        );
    }

    #[test]
    fn stop_when_idle_errors() {
        let s = RecordingSession::new();
        assert!(matches!(s.stop(), Err(SessionError::NotActive)));
    }

    #[test]
    fn push_event_appends_only_when_active() {
        let s = RecordingSession::new();
        // Push while idle — should be a no-op (no panic, no events accumulated).
        s.push_event(ev(0));
        s.start("rec-1".into(), None, None).unwrap();
        s.push_event(ev(1));
        s.push_event(ev(2));
        let stopped = s.stop().unwrap();
        assert_eq!(
            stopped.events.len(),
            2,
            "only post-start events should accumulate"
        );
        assert_eq!(stopped.events[0].timestamp(), 1);
        assert_eq!(stopped.events[1].timestamp(), 2);
    }

    #[test]
    fn start_resets_events_from_prior_session() {
        let s = RecordingSession::new();
        s.start("first".into(), None, None).unwrap();
        s.push_event(ev(1));
        s.push_event(ev(2));
        let _ = s.stop().unwrap();
        s.start("second".into(), None, None).unwrap();
        s.push_event(ev(99));
        let stopped = s.stop().unwrap();
        assert_eq!(stopped.id, "second");
        assert_eq!(
            stopped.events.len(),
            1,
            "new session should not inherit prior events"
        );
        assert_eq!(stopped.events[0].timestamp(), 99);
    }

    #[test]
    fn stop_returns_id_and_events() {
        let s = RecordingSession::new();
        s.start("rec-1".into(), None, None).unwrap();
        s.push_event(ev(10));
        let stopped = s.stop().unwrap();
        assert_eq!(stopped.id, "rec-1");
        assert_eq!(stopped.events.len(), 1);
        assert!(!s.is_active(), "stop should return to idle");
    }

    #[test]
    fn close_open_inputs_releases_a_key_at_stop_time() {
        let mut events = vec![
            InputEvent::KeyPress {
                key: "E".into(),
                timestamp: 100,
            },
            InputEvent::KeyRepeat {
                key: "E".into(),
                timestamp: 600,
            },
        ];

        close_open_inputs(&mut events, 900);

        assert!(matches!(
            events.last(),
            Some(InputEvent::KeyRelease { key, timestamp })
                if key == "E" && *timestamp == 900
        ));
    }

    #[test]
    fn close_open_inputs_does_not_duplicate_an_existing_release() {
        let mut events = vec![
            InputEvent::KeyPress {
                key: "E".into(),
                timestamp: 100,
            },
            InputEvent::KeyRelease {
                key: "E".into(),
                timestamp: 200,
            },
        ];

        close_open_inputs(&mut events, 900);

        assert_eq!(events.len(), 2);
    }

    #[test]
    fn collapse_x11_autorepeat_pairs_preserves_one_hold_and_drops_repeat_combo() {
        let mut events = vec![
            InputEvent::KeyPress {
                key: "E".into(),
                timestamp: 100,
            },
            InputEvent::KeyRelease {
                key: "E".into(),
                timestamp: 600,
            },
            InputEvent::KeyPress {
                key: "E".into(),
                timestamp: 600,
            },
            InputEvent::KeyCombo {
                char: "e".into(),
                key: "E".into(),
                modifiers: Vec::new(),
                timestamp: 600,
            },
            InputEvent::KeyRelease {
                key: "E".into(),
                timestamp: 700,
            },
        ];

        collapse_x11_autorepeat_pairs(&mut events);

        assert!(matches!(
            events.as_slice(),
            [
                InputEvent::KeyPress { .. },
                InputEvent::KeyRepeat { .. },
                InputEvent::KeyRelease { .. }
            ]
        ));
    }

    #[test]
    fn is_active_flips_on_start_and_stop() {
        let s = RecordingSession::new();
        assert!(!s.is_active());
        s.start("rec-1".into(), None, None).unwrap();
        assert!(s.is_active());
        s.stop().unwrap();
        assert!(!s.is_active());
    }

    #[test]
    fn current_id_is_none_after_stop() {
        let s = RecordingSession::new();
        s.start("rec-1".into(), None, None).unwrap();
        s.stop().unwrap();
        assert_eq!(s.current_id(), None);
    }

    #[test]
    fn session_error_display_messages_are_stable() {
        // The error strings cross the Tauri boundary — they show up verbatim
        // in the frontend. Asserting on them protects against silent rewording.
        assert_eq!(SessionError::AlreadyActive.to_string(), "Already recording");
        assert_eq!(SessionError::NotActive.to_string(), "Not recording");
    }

    #[test]
    fn events_preserve_insertion_order_across_many_pushes() {
        let s = RecordingSession::new();
        s.start("rec-1".into(), None, None).unwrap();
        for i in 0..100 {
            s.push_event(ev(i));
        }
        let stopped = s.stop().unwrap();
        assert_eq!(stopped.events.len(), 100);
        for (i, e) in stopped.events.iter().enumerate() {
            assert_eq!(e.timestamp(), i as i64);
        }
    }

    #[test]
    fn stop_returns_perception_worker_pass_through() {
        use crate::perception::extractor::Extractor;
        use crate::perception::worker::PerceptionWorker;
        use crate::perception::{ObservationResult, Region};
        use render_core::frame::RgbaFrame;

        struct Noop;
        impl Extractor for Noop {
            fn extract(&self, _f: &RgbaFrame, _r: &Region) -> ObservationResult {
                ObservationResult::Color {
                    rgb: [0, 0, 0],
                    matched: false,
                }
            }
        }

        // Drop the sender up front so the worker thread exits immediately; the
        // session only needs to prove it carries the handle through start→stop.
        let (tx, rx) = std::sync::mpsc::sync_channel::<crate::capture::Frame>(1);
        drop(tx);
        let worker = PerceptionWorker::spawn(rx, 0, Box::new(Noop));

        let s = RecordingSession::new();
        s.start("rec-1".into(), None, Some(worker)).unwrap();
        let stopped = s.stop().unwrap();
        assert!(
            stopped.perception.is_some(),
            "perception worker must pass through start→stop"
        );
        assert!(stopped.perception.unwrap().finish().is_empty());
    }
}
