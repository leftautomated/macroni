//! macOS Space-switch watcher: NSWorkspace notification + private CGS space
//! listing (AltTab/yabai precedent). Native glue — coverage-excluded; the
//! diffing and dedup logic it feeds is pure and tested in space_switch.rs.
//! On ANY read/parse failure: log_warn and emit nothing (never guess).

use std::ffi::c_void;
use std::ptr::NonNull;
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};

use block2::RcBlock;
use chrono::Utc;
use core_foundation::array::{CFArray, CFArrayRef};
use core_foundation::base::{CFType, TCFType};
use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
use core_foundation::number::CFNumber;
use core_foundation::string::CFString;
use objc2_app_kit::{NSWorkspace, NSWorkspaceActiveSpaceDidChangeNotification};
use objc2_foundation::NSNotification;

use crate::recording_session::RecordingSession;
use crate::space_switch::{diff_snapshots, DisplaySpaces, SpaceSnapshot};
use crate::types::InputEvent;

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGSMainConnectionID() -> i32;
    fn CGSCopyManagedDisplaySpaces(cid: i32) -> CFArrayRef;
}

/// Read the ordered space list per display. None on any failure — the CGS
/// dictionary shape is undocumented private API, so a single missing/mistyped
/// key aborts the whole read rather than emitting a guessed snapshot.
fn read_snapshot() -> Option<SpaceSnapshot> {
    // Keys reused across every display/space dictionary. Built as CFType so the
    // typed `CFDictionary<CFType, CFType>::find(&key)` accessor accepts them
    // (matching the copy_window_info precedent in permissions.rs).
    let display_id_key = CFString::from_static_string("Display Identifier").as_CFType();
    let current_key = CFString::from_static_string("Current Space").as_CFType();
    let spaces_key = CFString::from_static_string("Spaces").as_CFType();
    let id64_key = CFString::from_static_string("id64").as_CFType();

    unsafe {
        let raw = CGSCopyManagedDisplaySpaces(CGSMainConnectionID());
        if raw.is_null() {
            return None;
        }
        // Create-rule: CGS returns an owned copy, so we take ownership of the
        // top-level array. Inner dictionaries/arrays are borrowed via get-rule
        // (the array retains them for its lifetime) — see the per-value wraps.
        let displays = CFArray::<*const c_void>::wrap_under_create_rule(raw);
        let mut out = Vec::new();
        for value in displays.get_all_values() {
            let display_dict =
                CFDictionary::<CFType, CFType>::wrap_under_get_rule(value as CFDictionaryRef);

            let display = display_dict
                .find(&display_id_key)?
                .downcast::<CFString>()?
                .to_string();

            let current_value = display_dict.find(&current_key)?;
            let current_dict = CFDictionary::<CFType, CFType>::wrap_under_get_rule(
                current_value.as_CFTypeRef() as CFDictionaryRef,
            );
            let current = current_dict
                .find(&id64_key)?
                .downcast::<CFNumber>()?
                .to_i64()? as u64;

            let spaces_value = display_dict.find(&spaces_key)?;
            let spaces = CFArray::<*const c_void>::wrap_under_get_rule(
                spaces_value.as_CFTypeRef() as CFArrayRef
            );
            let mut ordered = Vec::new();
            for space_value in spaces.get_all_values() {
                let space_dict = CFDictionary::<CFType, CFType>::wrap_under_get_rule(
                    space_value as CFDictionaryRef,
                );
                ordered.push(
                    space_dict
                        .find(&id64_key)?
                        .downcast::<CFNumber>()?
                        .to_i64()? as u64,
                );
            }

            out.push(DisplaySpaces {
                display,
                ordered,
                current,
            });
        }
        Some(SpaceSnapshot { displays: out })
    }
}

/// Register the active-space observer. Call once from Tauri setup (main
/// thread). The observer token intentionally lives for the app's lifetime.
pub fn install(tx: Sender<InputEvent>, session: Arc<RecordingSession>) {
    let prev = Mutex::new(read_snapshot());
    let block = RcBlock::new(move |_notif: NonNull<NSNotification>| {
        let Some(new) = read_snapshot() else {
            crate::observability::log_warn(
                "space_watch",
                "cgs_read_failed",
                "skipping switch",
                None,
            );
            return;
        };
        // Update the baseline on EVERY successful read — even when we send
        // nothing (inactive session, no directional change) — so the next diff
        // compares against reality, not a stale snapshot.
        // A poisoned lock (panic while held) must not turn every future space
        // switch into a panic too — recover the guard and keep going.
        let mut prev = prev.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
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
            Some(NSWorkspaceActiveSpaceDidChangeNotification),
            None,
            None,
            &block,
        );
        // App-lifetime observer: we never remove it, so leak the token rather
        // than drop it (dropping would deregister the observer immediately).
        std::mem::forget(token);
    }
}
