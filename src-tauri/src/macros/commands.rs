//! Tauri command surface for macros: CRUD through `MacroStore`, run/stop
//! through `MacroRunner`/`PlaybackEngine`, and `TauriMacroEmitter`, which
//! turns a run's progress into frontend events.
//!
//! `run_macro` shares the playback engine's single "one thing plays at a
//! time" slot with `play_recording`: `MacroRunner::start` claims it via
//! `PlaybackEngine::claim_for_macro`, so a macro run and a recording replay
//! can never run concurrently, and `stop_macro`/`stop_playback` both just
//! flip the same shared flag.

use serde::Serialize;
use serde_json::json;
#[cfg(target_os = "macos")]
use tauri::Manager;
use tauri::{AppHandle, Emitter as _, State};

#[cfg(target_os = "macos")]
use crate::macros::probe::LiveWaitProbe;
#[cfg(not(target_os = "macos"))]
use crate::macros::runner::WaitProbe;
use crate::macros::runner::{MacroEmitter, MacroRunner, RealClock};
use crate::macros::store::MacroStore;
use crate::macros::MacroDoc;
use crate::observability;
use crate::playback::RdevSimulator;
use crate::types::RecordingState;

/// Shared payload shape for `macro-node-started` / `macro-node-finished`.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NodeEventPayload {
    macro_id: String,
    node_id: String,
    index: usize,
}

/// Payload for `macro-run-finished`.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RunFinishedPayload {
    macro_id: String,
    ok: bool,
}

/// Payload for `macro-run-failed`.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RunFailedPayload {
    macro_id: String,
    node_id: String,
    reason: String,
}

/// Production `MacroEmitter`: broadcasts run progress to the frontend via
/// Tauri events. Mirrors `playback::ports::TauriEmitter`'s shape.
pub struct TauriMacroEmitter {
    app: AppHandle,
}

impl TauriMacroEmitter {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl MacroEmitter for TauriMacroEmitter {
    fn node_started(&self, macro_id: &str, node_id: &str, index: usize) {
        let _ = self.app.emit(
            "macro-node-started",
            NodeEventPayload {
                macro_id: macro_id.to_string(),
                node_id: node_id.to_string(),
                index,
            },
        );
    }

    fn node_finished(&self, macro_id: &str, node_id: &str, index: usize) {
        let _ = self.app.emit(
            "macro-node-finished",
            NodeEventPayload {
                macro_id: macro_id.to_string(),
                node_id: node_id.to_string(),
                index,
            },
        );
    }

    fn run_finished(&self, macro_id: &str, ok: bool) {
        let _ = self.app.emit(
            "macro-run-finished",
            RunFinishedPayload {
                macro_id: macro_id.to_string(),
                ok,
            },
        );
    }

    fn run_failed(&self, macro_id: &str, node_id: &str, reason: &str) {
        let _ = self.app.emit(
            "macro-run-failed",
            RunFailedPayload {
                macro_id: macro_id.to_string(),
                node_id: node_id.to_string(),
                reason: reason.to_string(),
            },
        );
    }
}

/// Non-macOS stand-in for `LiveWaitProbe`. Never actually evaluated:
/// `MacroRunner::start` runs `validate_runnable` before it ever spawns the
/// run, and that already rejects any doc containing a `WaitFor` node on
/// this platform — so a probe is never invoked here. It still has to exist
/// as a concrete `WaitProbe` for `run_macro` to type-check on non-macOS
/// targets.
#[cfg(not(target_os = "macos"))]
struct NoWaitProbe;

#[cfg(not(target_os = "macos"))]
impl WaitProbe for NoWaitProbe {
    fn evaluate(&mut self, _target: &crate::perception::Target) -> Result<bool, String> {
        Err("wait-unsupported".to_string())
    }
}

#[tauri::command]
pub fn save_macro(
    app: AppHandle,
    doc: MacroDoc,
    trace_id: Option<String>,
) -> Result<MacroDoc, String> {
    let fields = json!({ "macroId": doc.id });
    observability::trace_command("save_macro", trace_id, Some(fields), || {
        MacroStore::open(&app)?.save(doc)
    })
}

#[tauri::command]
pub fn load_macros(app: AppHandle, trace_id: Option<String>) -> Result<Vec<MacroDoc>, String> {
    observability::trace_command("load_macros", trace_id, None, || {
        Ok(MacroStore::open(&app)?.load_all())
    })
}

#[tauri::command]
pub fn delete_macro(app: AppHandle, id: String, trace_id: Option<String>) -> Result<(), String> {
    let fields = json!({ "macroId": id });
    observability::trace_command("delete_macro", trace_id, Some(fields), || {
        MacroStore::open(&app)?.delete(&id)
    })
}

#[tauri::command]
pub fn run_macro(
    app: AppHandle,
    state: State<RecordingState>,
    id: String,
    trace_id: Option<String>,
) -> Result<(), String> {
    let fields = json!({ "macroId": id });
    observability::trace_command("run_macro", trace_id, Some(fields), || {
        let doc = MacroStore::open(&app)?
            .load_all()
            .into_iter()
            .find(|d| d.id == id)
            .ok_or_else(|| "Macro not found".to_string())?;

        let emitter = TauriMacroEmitter::new(app.clone());

        #[cfg(target_os = "macos")]
        {
            let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
            let macro_dir = data_dir.join("macros").join(&id);
            MacroRunner::start(
                doc,
                &state.engine,
                RdevSimulator,
                LiveWaitProbe::new(macro_dir),
                RealClock,
                emitter,
            )
        }
        #[cfg(not(target_os = "macos"))]
        {
            MacroRunner::start(
                doc,
                &state.engine,
                RdevSimulator,
                NoWaitProbe,
                RealClock,
                emitter,
            )
        }
    })
}

#[tauri::command]
pub fn stop_macro(state: State<RecordingState>, trace_id: Option<String>) -> Result<(), String> {
    observability::trace_command("stop_macro", trace_id, None, || {
        state.engine.stop();
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_payloads_serialize_camel_case() {
        let p = NodeEventPayload {
            macro_id: "m".into(),
            node_id: "n".into(),
            index: 2,
        };
        assert_eq!(
            serde_json::to_string(&p).unwrap(),
            r#"{"macroId":"m","nodeId":"n","index":2}"#
        );
    }

    #[test]
    fn run_finished_payload_serializes_camel_case() {
        let p = RunFinishedPayload {
            macro_id: "m".into(),
            ok: true,
        };
        assert_eq!(
            serde_json::to_string(&p).unwrap(),
            r#"{"macroId":"m","ok":true}"#
        );
    }

    #[test]
    fn run_failed_payload_serializes_camel_case() {
        let p = RunFailedPayload {
            macro_id: "m".into(),
            node_id: "n".into(),
            reason: "timeout".into(),
        };
        assert_eq!(
            serde_json::to_string(&p).unwrap(),
            r#"{"macroId":"m","nodeId":"n","reason":"timeout"}"#
        );
    }
}
