//! RAII "no App Nap" guard.
//!
//! macOS puts a background app to sleep (App Nap) and coalesces its timers
//! when it isn't frontmost. Because macroni's main window is a non-activating
//! `NSPanel`, a real replay — where the user focuses their target app and
//! macroni drops to the background — gets napped, and the replay worker's
//! `thread::sleep` calls stretch/coalesce, inflating every sleep in the loop.
//!
//! Holding an `NSProcessInfo` activity assertion for the duration of a run
//! fixes this: `UserInitiated` prevents App Nap and `LatencyCritical` disables
//! timer coalescing, so background sleeps run at their true durations. The
//! guard begins the assertion on construction and ends it on `Drop`, so callers
//! just keep it alive (`let _no_nap = NoNapGuard::new(..)`) for the whole run.
//!
//! Native glue — coverage-excluded. On non-macOS there is no App Nap, so the
//! guard compiles to a zero-cost no-op and call sites stay cross-platform.

#[cfg(target_os = "macos")]
use objc2::rc::Retained;
#[cfg(target_os = "macos")]
use objc2::runtime::{NSObjectProtocol, ProtocolObject};
#[cfg(target_os = "macos")]
use objc2_foundation::{NSActivityOptions, NSProcessInfo, NSString};

/// Holds a macOS activity assertion that keeps the app awake and its timers
/// un-coalesced until the guard is dropped.
#[cfg(target_os = "macos")]
pub struct NoNapGuard {
    /// The opaque activity token returned by `beginActivityWithOptions:reason:`,
    /// passed back to `endActivity:` on drop.
    token: Retained<ProtocolObject<dyn NSObjectProtocol>>,
}

#[cfg(target_os = "macos")]
impl NoNapGuard {
    /// Begin an activity assertion combining `UserInitiated` (prevents App Nap)
    /// and `LatencyCritical` (disables timer coalescing). Safe to call from any
    /// thread — the assertion is app-global, so the replay worker can hold it.
    /// `reason` is a human-readable label surfaced in activity diagnostics.
    pub fn new(reason: &str) -> Self {
        let token = NSProcessInfo::processInfo().beginActivityWithOptions_reason(
            NSActivityOptions::UserInitiated | NSActivityOptions::LatencyCritical,
            &NSString::from_str(reason),
        );
        Self { token }
    }
}

#[cfg(target_os = "macos")]
impl Drop for NoNapGuard {
    fn drop(&mut self) {
        // SAFETY: `self.token` is exactly the assertion returned by the paired
        // `beginActivityWithOptions:reason:` call in `new`, and is ended exactly
        // once (here, on drop), satisfying AppKit's begin/end activity contract.
        unsafe { NSProcessInfo::processInfo().endActivity(&self.token) };
    }
}

/// No-op guard on non-macOS: there is no App Nap to defeat, so it holds nothing
/// and needs no `Drop`. Keeps replay/macro call sites cross-platform.
#[cfg(not(target_os = "macos"))]
pub struct NoNapGuard;

#[cfg(not(target_os = "macos"))]
impl NoNapGuard {
    pub fn new(_reason: &str) -> Self {
        Self
    }
}
