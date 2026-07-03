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
use crate::types::InputEvent;

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
                events,
                capture,
                perception,
            } => Ok(StoppedSession {
                id,
                events,
                capture,
                perception,
            }),
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
        InputEvent::KeyPress {
            key: "A".into(),
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
        use render_core::decode::RgbaFrame;

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
