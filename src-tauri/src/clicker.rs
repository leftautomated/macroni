//! A small, indefinite auto-click loop that shares the playback engine's
//! cancellation flag. Its timing stays separate from recording replay because
//! replay intentionally adds warmup and loop gaps that would skew click rates.

use crate::playback::ports::{RdevSimulator, Simulator};
use rdev::{Button, EventType};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter as _};

const START_DELAY: Duration = Duration::from_secs(3);
const CLICK_HOLD: Duration = Duration::from_millis(5);
const MIN_INTERVAL: Duration = Duration::from_millis(10);

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct ClickerConfig {
    button: Button,
    interval: Duration,
}

impl ClickerConfig {
    pub(crate) fn parse(
        button: &str,
        clicks_per_period: u32,
        period: &str,
    ) -> Result<Self, String> {
        let button = match button {
            "left" => Button::Left,
            "right" => Button::Right,
            "middle" => Button::Middle,
            _ => return Err("Mouse button must be left, right, or middle".to_string()),
        };
        if clicks_per_period == 0 {
            return Err("Clicks per period must be at least 1".to_string());
        }

        let period = match period {
            "second" => Duration::from_secs(1),
            "minute" => Duration::from_secs(60),
            "hour" => Duration::from_secs(60 * 60),
            _ => return Err("Period must be second, minute, or hour".to_string()),
        };
        let interval = period.div_f64(f64::from(clicks_per_period));
        if interval < MIN_INTERVAL {
            return Err("Click rate cannot exceed 100 clicks per second".to_string());
        }

        Ok(Self { button, interval })
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClickerStoppedPayload {
    error: Option<String>,
}

trait ClickerEmitter: Send + 'static {
    fn emit_started(&self);
    fn emit_stopped(&self, error: Option<String>);
}

struct TauriClickerEmitter {
    app: AppHandle,
}

impl ClickerEmitter for TauriClickerEmitter {
    fn emit_started(&self) {
        let _ = self.app.emit("clicker-started", ());
    }

    fn emit_stopped(&self, error: Option<String>) {
        let _ = self
            .app
            .emit("clicker-stopped", ClickerStoppedPayload { error });
    }
}

pub(crate) fn start(config: ClickerConfig, cancel: Arc<AtomicBool>, app: AppHandle) {
    thread::spawn(move || {
        run_clicker(
            config,
            START_DELAY,
            &cancel,
            RdevSimulator,
            TauriClickerEmitter { app },
        );
    });
}

fn run_clicker(
    config: ClickerConfig,
    start_delay: Duration,
    cancel: &AtomicBool,
    simulator: impl Simulator,
    emitter: impl ClickerEmitter,
) {
    let _no_nap = crate::power::NoNapGuard::new("Running auto clicker");
    if !sleep_cancellable(start_delay, cancel) {
        emitter.emit_stopped(None);
        return;
    }

    emitter.emit_started();
    let mut next_click = Instant::now();
    let mut error = None;

    loop {
        if !cancel.load(Ordering::Relaxed) {
            break;
        }
        if let Err(message) = simulator.simulate(EventType::ButtonPress(config.button)) {
            error = Some(format!("Could not press the mouse button: {message}"));
            break;
        }

        // Always release a successful press, even when Stop arrives during the
        // brief hold. Leaving a mouse button down is worse than one final release.
        thread::sleep(CLICK_HOLD);
        if let Err(message) = simulator.simulate(EventType::ButtonRelease(config.button)) {
            error = Some(format!("Could not release the mouse button: {message}"));
            break;
        }

        next_click += config.interval;
        let now = Instant::now();
        if next_click <= now {
            // Never burst clicks to catch up after the OS pauses this thread.
            next_click = now + config.interval;
        }
        if !sleep_cancellable(next_click.saturating_duration_since(now), cancel) {
            break;
        }
    }

    cancel.store(false, Ordering::Relaxed);
    if let Some(message) = error.as_deref() {
        crate::observability::log_error("clicker", "simulation_failed", message, None);
    }
    emitter.emit_stopped(error);
}

fn sleep_cancellable(duration: Duration, cancel: &AtomicBool) -> bool {
    let deadline = Instant::now() + duration;
    while Instant::now() < deadline {
        if !cancel.load(Ordering::Relaxed) {
            return false;
        }
        thread::sleep(
            deadline
                .saturating_duration_since(Instant::now())
                .min(Duration::from_millis(10)),
        );
    }
    cancel.load(Ordering::Relaxed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[derive(Clone)]
    struct FakeSimulator {
        calls: Arc<Mutex<Vec<EventType>>>,
        cancel_after_release: Arc<AtomicBool>,
    }

    impl Simulator for FakeSimulator {
        fn simulate(&self, event_type: EventType) -> Result<(), String> {
            self.calls.lock().unwrap().push(event_type);
            if matches!(event_type, EventType::ButtonRelease(_)) {
                self.cancel_after_release.store(false, Ordering::Relaxed);
            }
            Ok(())
        }
    }

    #[derive(Default)]
    struct FakeEmitter {
        started: Arc<AtomicBool>,
        stopped: Arc<Mutex<Vec<Option<String>>>>,
    }

    impl ClickerEmitter for FakeEmitter {
        fn emit_started(&self) {
            self.started.store(true, Ordering::Relaxed);
        }

        fn emit_stopped(&self, error: Option<String>) {
            self.stopped.lock().unwrap().push(error);
        }
    }

    #[test]
    fn parses_supported_controls_and_rejects_unsafe_rates() {
        let config = ClickerConfig::parse("left", 10, "second").unwrap();
        assert_eq!(config.button, Button::Left);
        assert_eq!(config.interval, Duration::from_millis(100));
        assert!(ClickerConfig::parse("left", 0, "second").is_err());
        assert!(ClickerConfig::parse("side", 10, "second").is_err());
        assert!(ClickerConfig::parse("left", 101, "second").is_err());
    }

    #[test]
    fn emits_one_balanced_click_then_stops_when_cancelled() {
        let cancel = Arc::new(AtomicBool::new(true));
        let calls = Arc::new(Mutex::new(Vec::new()));
        let simulator = FakeSimulator {
            calls: Arc::clone(&calls),
            cancel_after_release: Arc::clone(&cancel),
        };
        let emitter = FakeEmitter::default();
        let started = Arc::clone(&emitter.started);
        let stopped = Arc::clone(&emitter.stopped);

        run_clicker(
            ClickerConfig::parse("right", 10, "second").unwrap(),
            Duration::ZERO,
            &cancel,
            simulator,
            emitter,
        );

        assert!(started.load(Ordering::Relaxed));
        assert_eq!(
            calls.lock().unwrap().as_slice(),
            [
                EventType::ButtonPress(Button::Right),
                EventType::ButtonRelease(Button::Right),
            ]
        );
        assert_eq!(stopped.lock().unwrap().as_slice(), [None]);
    }

    #[test]
    fn cancelling_during_arming_never_clicks() {
        let cancel = Arc::new(AtomicBool::new(false));
        let calls = Arc::new(Mutex::new(Vec::new()));
        let emitter = FakeEmitter::default();
        let started = Arc::clone(&emitter.started);

        run_clicker(
            ClickerConfig::parse("left", 10, "second").unwrap(),
            Duration::from_millis(10),
            &cancel,
            FakeSimulator {
                calls: Arc::clone(&calls),
                cancel_after_release: Arc::clone(&cancel),
            },
            emitter,
        );

        assert!(!started.load(Ordering::Relaxed));
        assert!(calls.lock().unwrap().is_empty());
    }
}
