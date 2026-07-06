# Macro Model + Linear Runtime (Sub-Project A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Headless macro artifact + linear runtime: self-contained `MacroDoc` files (segment + wait-for nodes), a store with asset copying, and a runner that replays segments through the existing playback machinery and gates on perception waits. Spec: `docs/superpowers/specs/2026-07-05-macro-graph-runtime-design.md` (sub-project A).

**Architecture:** `macros/` module: pure types + chain validation (`mod.rs`), per-file JSON store with asset copy (`store.rs`), a runner over injected ports (`runner.rs`) — Simulator reused from playback, new `WaitProbe`/`MacroClock`/`MacroEmitter` traits for testability, real probe as thin macOS glue (`probe.rs`). The runner claims the SAME engine slot as playback (mutual exclusion + shared stop). Step execution is extracted from `run_plan` into a shared helper so segments replay byte-for-byte like normal playback.

**Tech Stack:** Rust (serde, existing playback/perception seams), TS mirrors, vitest untouched (no UI in A).

## Global Constraints

- **Never destabilize recording or playback:** engine refactor is extract-only — all existing engine tests stay green unchanged (except imports); `run_plan` behavior identical.
- **Self-contained macros:** `macros/{id}.json` + `macros/{id}/assets/`; save copies TemplateMatch images to `assets/{target_id}.png` and rewrites `image` to that macro-relative path; delete removes both; sweep prunes orphan asset dirs AND orphan jsons.
- **Linear-chain validation:** non-chain graphs rejected at save AND at run with typed `MacroError`s (stable Display strings — frontend may match). Never partially executed.
- **Wait semantics (exact):** evaluate first (immediate-match), then `elapsed >= timeout_ms` → fail `"timeout"`, else sleep `poll_interval_ms.max(100)` cancellably. Stop during wait → fail reason `"stopped"`. Probe error → `"evaluation-error: {e}"`. Text match = `expect` None → any span; Some → any span whose text contains expect case-insensitively. Template/Color → their `matched` flags. Accurate-mode OCR (fast: false).
- **Mutual exclusion:** macro runs claim `PlaybackEngine`'s `is_playing` slot for the WHOLE run; `engine.stop()` (Cmd+R, stop_playback, stop_macro) cancels macro runs.
- **macOS-first:** running a doc containing WaitFor on non-macOS fails validation with `MacroError::WaitUnsupportedPlatform` BEFORE any input is simulated.
- **Forward compat:** per-macro files parse-or-skip with `log_warn` (a future node kind must not break load_all).
- **Deferred (do NOT build):** branching/loops, canvas UI, snipping UI, re-pull, run history.
- Serde house tagging `#[serde(tag = "type", rename_all = "PascalCase")]` for `MacroNodeKind`. Defaults: `speed` 1.0, `timeout_ms` 10_000, `poll_interval_ms` 500.
- Checks per task: `cargo test`, `cargo fmt --all`, `cargo clippy --all-targets -- -D warnings` (pre-existing permissions.rs:1437 exempt), `pnpm typecheck` when TS touched. House `#[allow(dead_code)] // consumed by Task N (…)` pattern for not-yet-consumed items.

## File Structure

- `src-tauri/src/macros/mod.rs` (NEW) — types, serde, `chain_order`, `validate_runnable`, `MacroError`.
- `src-tauri/src/macros/store.rs` (NEW) — `MacroStore`.
- `src-tauri/src/macros/runner.rs` (NEW) — ports (`WaitProbe`, `MacroClock`, `MacroEmitter`), `run_macro_chain` core, `MacroRunner::start`.
- `src-tauri/src/macros/probe.rs` (NEW, macOS) — real probe (LiveSource + extractor).
- `src-tauri/src/macros/commands.rs` (NEW) — Tauri commands + `TauriMacroEmitter`.
- `src-tauri/src/playback/engine.rs` (MODIFY) — extract `execute_steps`, add `claim_for_macro`.
- `src-tauri/src/perception/commands.rs` (MODIFY) — factor `build_extractor_with_base`.
- `src-tauri/src/lib.rs` (MODIFY) — `mod macros;`, command registration.
- `src/types.ts` (MODIFY) — mirrors. `.github/workflows/test.yml` (MODIFY) — add `probe.rs` to exclusion.

---

### Task 1: Types, serde, chain validation

**Files:**
- Create: `src-tauri/src/macros/mod.rs`
- Modify: `src-tauri/src/lib.rs` (`mod macros;`), `src/types.ts`

**Interfaces (Produces):**
- `pub struct MacroDoc { pub id: String, pub name: String, pub nodes: Vec<MacroNode>, pub edges: Vec<MacroEdge>, pub created_at: i64 }`
- `pub struct MacroEdge { pub from: String, pub to: String }`
- `pub struct MacroNode { pub id: String, pub kind: MacroNodeKind, pub x: f32, pub y: f32 }`
- `pub enum MacroNodeKind` — `Segment { events: Vec<InputEvent>, #[serde(default = "default_speed")] speed: f64, provenance: Option<Provenance> }`, `WaitFor { target: crate::perception::Target, #[serde(default = "default_timeout_ms")] timeout_ms: u64, #[serde(default = "default_poll_interval_ms")] poll_interval_ms: u64 }`
- `pub struct Provenance { pub recording_id: String, pub start_ms: i64, pub end_ms: i64 }`
- `pub fn chain_order(doc: &MacroDoc) -> Result<Vec<&MacroNode>, MacroError>`
- `pub fn validate_runnable(doc: &MacroDoc) -> Result<(), MacroError>` (chain + platform check for WaitFor)
- `pub enum MacroError { EmptyMacro, NotAChain, UnknownNode(String), DuplicateEdge, WaitUnsupportedPlatform }` with stable Display: `"Macro has no nodes"`, `"Macro nodes must form a single linear chain"`, `"Edge references unknown node '{id}'"`, `"Duplicate or conflicting edge"`, `"Wait nodes require macOS"`.
- All derives `Debug, Clone, PartialEq, Serialize, Deserialize` (error: `Debug, PartialEq`).

- [ ] **Step 1: Failing tests** (in-file `mod tests`):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::InputEvent;

    fn seg(id: &str) -> MacroNode {
        MacroNode {
            id: id.into(),
            kind: MacroNodeKind::Segment {
                events: vec![InputEvent::KeyPress { key: "A".into(), timestamp: 0 }],
                speed: 1.0,
                provenance: None,
            },
            x: 0.0,
            y: 0.0,
        }
    }
    fn edge(from: &str, to: &str) -> MacroEdge {
        MacroEdge { from: from.into(), to: to.into() }
    }
    fn doc(nodes: Vec<MacroNode>, edges: Vec<MacroEdge>) -> MacroDoc {
        MacroDoc { id: "m1".into(), name: "test".into(), nodes, edges, created_at: 1 }
    }

    #[test]
    fn chain_order_resolves_a_valid_chain_regardless_of_vec_order() {
        let d = doc(vec![seg("c"), seg("a"), seg("b")], vec![edge("a", "b"), edge("b", "c")]);
        let order: Vec<&str> = chain_order(&d).unwrap().iter().map(|n| n.id.as_str()).collect();
        assert_eq!(order, vec!["a", "b", "c"]);
    }

    #[test]
    fn chain_order_single_node_no_edges_is_valid() {
        let d = doc(vec![seg("only")], vec![]);
        assert_eq!(chain_order(&d).unwrap().len(), 1);
    }

    #[test]
    fn chain_order_rejects_invalid_shapes_with_typed_errors() {
        assert_eq!(chain_order(&doc(vec![], vec![])), Err(MacroError::EmptyMacro));
        // Fork: a -> b and a -> c.
        let fork = doc(vec![seg("a"), seg("b"), seg("c")], vec![edge("a", "b"), edge("a", "c")]);
        assert_eq!(chain_order(&fork), Err(MacroError::DuplicateEdge));
        // Cycle: a -> b -> a (no start node).
        let cycle = doc(vec![seg("a"), seg("b")], vec![edge("a", "b"), edge("b", "a")]);
        assert_eq!(chain_order(&cycle), Err(MacroError::NotAChain));
        // Orphan: two nodes, no edge between them (two starts).
        let orphan = doc(vec![seg("a"), seg("b")], vec![]);
        assert_eq!(chain_order(&orphan), Err(MacroError::NotAChain));
        // Unknown node id in an edge.
        let unknown = doc(vec![seg("a")], vec![edge("a", "ghost")]);
        assert_eq!(chain_order(&unknown), Err(MacroError::UnknownNode("ghost".into())));
        // Self-edge.
        let selfe = doc(vec![seg("a")], vec![edge("a", "a")]);
        assert!(chain_order(&selfe).is_err());
    }

    #[test]
    fn macro_doc_serde_round_trips_with_house_tagging_and_defaults() {
        let d = doc(vec![seg("a")], vec![]);
        let json = serde_json::to_string(&d).unwrap();
        assert!(json.contains("\"type\":\"Segment\""), "{json}");
        let back: MacroDoc = serde_json::from_str(&json).unwrap();
        assert_eq!(back, d);
        // Missing optional fields default.
        let wait_json = r#"{"id":"w","kind":{"type":"WaitFor","target":{"id":"t","name":"n","modality":"visual","region":{"x":0.1,"y":0.1,"w":0.1,"h":0.1},"kind":{"type":"TextOcr","expect":"Go"},"created_at":1}},"x":0,"y":0}"#;
        let node: MacroNode = serde_json::from_str(wait_json).unwrap();
        match node.kind {
            MacroNodeKind::WaitFor { timeout_ms, poll_interval_ms, .. } => {
                assert_eq!(timeout_ms, 10_000);
                assert_eq!(poll_interval_ms, 500);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn error_display_strings_are_stable() {
        assert_eq!(MacroError::EmptyMacro.to_string(), "Macro has no nodes");
        assert_eq!(MacroError::NotAChain.to_string(), "Macro nodes must form a single linear chain");
        assert_eq!(MacroError::UnknownNode("x".into()).to_string(), "Edge references unknown node 'x'");
        assert_eq!(MacroError::DuplicateEdge.to_string(), "Duplicate or conflicting edge");
        assert_eq!(MacroError::WaitUnsupportedPlatform.to_string(), "Wait nodes require macOS");
    }
}
```

- [ ] **Step 2:** `cd src-tauri && cargo test macros::` → FAIL (module missing).
- [ ] **Step 3: Implement.** `chain_order` algorithm: build `HashMap<id, &MacroNode>` (reject unknown/self edges → `UnknownNode`/`DuplicateEdge`); count in/out degrees — any node with out-degree or in-degree > 1 → `DuplicateEdge`; exactly one start (in-degree 0) and one end (out-degree 0) required unless single-node/no-edge; walk from start following the out-edge map collecting nodes; if walked count != nodes.len() → `NotAChain` (covers cycles + orphans; a cycle has no start → `NotAChain`). `validate_runnable`: `chain_order`? + on `#[cfg(not(target_os = "macos"))]` return `WaitUnsupportedPlatform` if any node is WaitFor. Defaults: `fn default_speed() -> f64 { 1.0 }`, `fn default_timeout_ms() -> u64 { 10_000 }`, `fn default_poll_interval_ms() -> u64 { 500 }` with `#[serde(default = …)]`. Register `mod macros;` in lib.rs (alphabetical). House allows for not-yet-consumed items (`// consumed by Task 2 (store) / Task 4 (runner)`).
- [ ] **Step 4: TS mirrors** in `src/types.ts`:

```ts
export interface MacroEdge {
  from: string;
  to: string;
}

export interface MacroProvenance {
  recording_id: string;
  start_ms: number;
  end_ms: number;
}

export type MacroNodeKind =
  | {
      type: "Segment";
      events: InputEvent[];
      speed: number;
      provenance?: MacroProvenance | null;
    }
  | {
      type: "WaitFor";
      target: PerceptionTarget;
      timeout_ms: number;
      poll_interval_ms: number;
    };

export interface MacroNode {
  id: string;
  kind: MacroNodeKind;
  x: number;
  y: number;
}

export interface MacroDoc {
  id: string;
  name: string;
  nodes: MacroNode[];
  edges: MacroEdge[];
  created_at: number;
}
```

- [ ] **Step 5:** `cargo test && cargo fmt --all && cargo clippy --all-targets -- -D warnings` and `pnpm typecheck` → PASS.
- [ ] **Step 6: Commit** `git add -A src-tauri/src src/types.ts && git commit -m "feat(macros): macro doc model with chain validation"`

---

### Task 2: MacroStore — per-file persistence + asset copy + sweep

**Files:**
- Create: `src-tauri/src/macros/store.rs`
- Modify: `src-tauri/src/macros/mod.rs` (`pub mod store;`)

**Interfaces:**
- Consumes: Task 1 types; `crate::recordings_store::atomic_write` — make that helper `pub(crate)` (it is currently private; change `fn atomic_write` → `pub(crate) fn atomic_write` in recordings_store.rs).
- Produces `MacroStore`:
  - `open(app: &AppHandle) -> Result<Self, String>` / `open_at(data_dir: PathBuf) -> Self` (test seam)
  - `macros_dir()` = `<data_dir>/macros`; doc path `macros/{id}.json`; assets dir `macros/{id}/assets`
  - `load_all(&self) -> Vec<MacroDoc>` — reads every `*.json` in `macros/`; unparseable file → `log_warn("macros", "macro_json_unreadable", …)` + skip (forward compat)
  - `save(&self, doc: MacroDoc) -> Result<MacroDoc, String>` — `chain_order` validation first; then for each WaitFor node with `TargetKind::TemplateMatch` whose `image` does NOT start with `"assets/"`: copy `<data_dir>/<image>` → `macros/{doc.id}/assets/{target.id}.png` and rewrite `image` to `assets/{target.id}.png` (missing source file → `Err("template image not found: …")`); then atomic-write the json; returns the (rewritten) doc
  - `delete(&self, id: &str) -> Result<(), String>` — remove json + `macros/{id}/` dir; `Err("Macro not found")` if no json
  - `sweep_orphans(&self)` — remove `macros/*.json`-less `{id}/` dirs and nothing else

- [ ] **Step 1: Failing tests** (tempdir-based, mirroring recordings_store test style):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::macros::{MacroDoc, MacroEdge, MacroNode, MacroNodeKind};
    use crate::perception::{Modality, Region, Target, TargetKind};
    use crate::types::InputEvent;
    use tempfile::tempdir;

    fn seg_doc(id: &str) -> MacroDoc {
        MacroDoc {
            id: id.into(),
            name: "m".into(),
            nodes: vec![MacroNode {
                id: "n1".into(),
                kind: MacroNodeKind::Segment {
                    events: vec![InputEvent::KeyPress { key: "A".into(), timestamp: 0 }],
                    speed: 1.0,
                    provenance: None,
                },
                x: 0.0,
                y: 0.0,
            }],
            edges: vec![],
            created_at: 1,
        }
    }

    #[test]
    fn save_load_round_trips_and_skips_unreadable_files() {
        let dir = tempdir().unwrap();
        let store = MacroStore::open_at(dir.path().to_path_buf());
        store.save(seg_doc("m1")).unwrap();
        std::fs::write(dir.path().join("macros/broken.json"), b"{nope").unwrap();
        let all = store.load_all();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].id, "m1");
    }

    #[test]
    fn save_rejects_invalid_chains() {
        let dir = tempdir().unwrap();
        let store = MacroStore::open_at(dir.path().to_path_buf());
        let mut d = seg_doc("bad");
        d.edges.push(MacroEdge { from: "n1".into(), to: "ghost".into() });
        assert!(store.save(d).is_err());
        assert!(!dir.path().join("macros/bad.json").exists());
    }

    #[test]
    fn save_copies_template_assets_and_rewrites_paths() {
        let dir = tempdir().unwrap();
        // Simulate a recording's template at the perception layout.
        std::fs::create_dir_all(dir.path().join("targets/rec1")).unwrap();
        std::fs::write(dir.path().join("targets/rec1/t9.png"), b"png-bytes").unwrap();
        let store = MacroStore::open_at(dir.path().to_path_buf());
        let mut d = seg_doc("m2");
        d.nodes.push(MacroNode {
            id: "n2".into(),
            kind: MacroNodeKind::WaitFor {
                target: Target {
                    id: "t9".into(),
                    name: "logo".into(),
                    modality: Modality::Visual,
                    region: Some(Region { x: 0.0, y: 0.0, w: 0.5, h: 0.5 }),
                    kind: TargetKind::TemplateMatch {
                        image: "targets/rec1/t9.png".into(),
                        threshold: 0.8,
                        source_px: [100, 100],
                    },
                    created_at: 1,
                },
                timeout_ms: 10_000,
                poll_interval_ms: 500,
            },
            x: 0.0,
            y: 0.0,
        });
        d.edges.push(MacroEdge { from: "n1".into(), to: "n2".into() });
        let saved = store.save(d).unwrap();
        assert!(dir.path().join("macros/m2/assets/t9.png").exists());
        match &saved.nodes[1].kind {
            MacroNodeKind::WaitFor { target, .. } => match &target.kind {
                TargetKind::TemplateMatch { image, .. } => assert_eq!(image, "assets/t9.png"),
                other => panic!("{other:?}"),
            },
            other => panic!("{other:?}"),
        }
        // Saving again is idempotent (already assets/-relative: no re-copy, no error).
        assert!(store.save(saved).is_ok());
    }

    #[test]
    fn delete_removes_json_and_assets_dir() {
        let dir = tempdir().unwrap();
        let store = MacroStore::open_at(dir.path().to_path_buf());
        store.save(seg_doc("m3")).unwrap();
        std::fs::create_dir_all(dir.path().join("macros/m3/assets")).unwrap();
        store.delete("m3").unwrap();
        assert!(!dir.path().join("macros/m3.json").exists());
        assert!(!dir.path().join("macros/m3").exists());
        assert!(store.delete("m3").is_err());
    }

    #[test]
    fn sweep_removes_asset_dirs_without_json() {
        let dir = tempdir().unwrap();
        let store = MacroStore::open_at(dir.path().to_path_buf());
        store.save(seg_doc("keep")).unwrap();
        std::fs::create_dir_all(dir.path().join("macros/keep/assets")).unwrap();
        std::fs::create_dir_all(dir.path().join("macros/orphan/assets")).unwrap();
        store.sweep_orphans();
        assert!(dir.path().join("macros/keep").exists());
        assert!(!dir.path().join("macros/orphan").exists());
    }
}
```

- [ ] **Step 2:** `cargo test macros::store` → FAIL.
- [ ] **Step 3: Implement** per the interface block (String errors are fine here — commands surface them as-is; validation errors map through `MacroError`'s Display). Call `store.sweep_orphans()` in lib.rs setup next to the other sweeps. Make `atomic_write` `pub(crate)` and reuse.
- [ ] **Step 4:** full checks → PASS.
- [ ] **Step 5: Commit** `git commit -am "feat(macros): per-file macro store with asset copy and sweep"`

---

### Task 3: Engine seam — `execute_steps` + `claim_for_macro`

**Files:**
- Modify: `src-tauri/src/playback/engine.rs`

**Interfaces (Produces):**
- `pub(crate) fn execute_steps(steps: &[PlannedStep], cancel: &AtomicBool, simulator: &impl Simulator, mut on_position: impl FnMut(usize)) -> bool` — the body of `run_plan`'s inner `for step in &plan.steps` loop, verbatim semantics (position callback replaces the mutex+emitter pair; Simulate re-checks cancel; Sleep via `sleep_cancellable`); returns `completed`.
- `run_plan` refactored to call it: `let completed = execute_steps(&plan.steps, is_playing, &simulator, |i| { if let Ok(mut p) = position.lock() { *p = Some(i); } emitter.emit_position(i); });`
- `pub(crate) fn claim_for_macro(&self) -> Result<Arc<AtomicBool>, String>` on `PlaybackEngine` — `swap(true)`; `Err("Already playing")` if taken; returns a clone of the `is_playing` Arc (the macro runner releases by storing false; `engine.stop()` cancels it).
- `sleep_cancellable` becomes `pub(crate)`.

- [ ] **Step 1: Failing tests** (append to engine tests):

```rust
    #[test]
    fn claim_for_macro_excludes_playback_and_stop_releases() {
        let engine = PlaybackEngine::new();
        let flag = engine.claim_for_macro().unwrap();
        assert!(engine.is_playing());
        // Playback cannot start while a macro holds the slot.
        assert!(engine
            .start(trivial_plan(), false, FakeSimulator::default(), FakeEmitter::default())
            .is_err());
        // A second macro cannot claim either.
        assert!(engine.claim_for_macro().is_err());
        // engine.stop() flips the shared flag — the macro runner sees it.
        engine.stop();
        assert!(!flag.load(Ordering::Relaxed));
        // Slot reusable after release.
        assert!(engine.claim_for_macro().is_ok());
        engine.stop();
    }

    #[test]
    fn execute_steps_runs_and_respects_cancellation() {
        let sim = FakeSimulator::default();
        let calls = Arc::clone(&sim.calls);
        let cancel = AtomicBool::new(true);
        let mut positions = Vec::new();
        let steps = vec![
            PlannedStep::EmitPosition { index: 7 },
            PlannedStep::Simulate(EventType::KeyPress(Key::KeyA)),
        ];
        assert!(execute_steps(&steps, &cancel, &sim, |i| positions.push(i)));
        assert_eq!(calls.lock().unwrap().len(), 1);
        assert_eq!(positions, vec![7]);
        // Cancelled flag short-circuits before simulating.
        cancel.store(false, Ordering::Relaxed);
        assert!(!execute_steps(&steps, &cancel, &sim, |_| {}));
        assert_eq!(calls.lock().unwrap().len(), 1, "no new simulate after cancel");
    }
```

- [ ] **Step 2:** `cargo test playback::engine` → FAIL (functions missing).
- [ ] **Step 3: Implement** the extraction. The diff is mechanical: move the `for step in &plan.steps { … }` body into `execute_steps` exactly as-is (the `completed` local becomes the return), replacing the two position-update lines with `on_position(*index)`. `run_plan` keeps its loop/warmup/finalize logic untouched. All 12 existing engine tests must pass UNCHANGED — that is the refactor's regression net.
- [ ] **Step 4:** full checks → PASS (existing tests untouched and green).
- [ ] **Step 5: Commit** `git commit -am "refactor(playback): extract step execution and macro slot claim"`

---

### Task 4: MacroRunner core with fake ports

**Files:**
- Create: `src-tauri/src/macros/runner.rs`
- Modify: `src-tauri/src/macros/mod.rs` (`pub mod runner;`)

**Interfaces:**
- Consumes: Task 1 (`chain_order`, types), Task 3 (`execute_steps`, `sleep_cancellable` via a real-clock impl), `PlaybackPlan::compile`, `Simulator`.
- Produces:

```rust
pub trait WaitProbe: Send + 'static {
    fn evaluate(&mut self, target: &crate::perception::Target) -> Result<bool, String>;
}

pub trait MacroClock: Send + 'static {
    fn now_ms(&self) -> i64;
    /// Cancellable sleep; false = cancelled.
    fn sleep_ms(&self, ms: u64, cancel: &std::sync::atomic::AtomicBool) -> bool;
}

pub trait MacroEmitter: Send + 'static {
    fn node_started(&self, macro_id: &str, node_id: &str, index: usize);
    fn node_finished(&self, macro_id: &str, node_id: &str, index: usize);
    fn run_finished(&self, macro_id: &str, ok: bool);
    fn run_failed(&self, macro_id: &str, node_id: &str, reason: &str);
}

pub struct RealClock;   // Utc::now + playback::engine::sleep_cancellable

/// Walks the chain synchronously on the caller's thread; `cancel` is the
/// claimed engine flag. Releases NOTHING itself — the caller owns the slot.
pub fn run_chain(
    doc: &MacroDoc,
    cancel: &AtomicBool,
    simulator: &impl Simulator,
    probe: &mut impl WaitProbe,
    clock: &impl MacroClock,
    emitter: &impl MacroEmitter,
) -> Result<(), ()>   // detail carried via emitter; Err = did not complete
```

  and `pub struct MacroRunner;` with `pub fn start(doc: MacroDoc, engine: &PlaybackEngine, simulator: impl Simulator, probe: impl WaitProbe, clock: impl MacroClock, emitter: impl MacroEmitter) -> Result<(), String>` — validates (`validate_runnable`), claims the slot, spawns a thread that calls `run_chain` then stores false on the flag (always — every exit path).
- Wait node semantics (exact, from Global Constraints): per poll — check cancel (`false` → `run_failed(…, "stopped")`), `probe.evaluate` (`Err(e)` → `"evaluation-error: {e}"`; `Ok(true)` → node done), then `clock.now_ms() - start >= timeout_ms as i64` → `"timeout"`, then `clock.sleep_ms(poll_interval_ms.max(100), cancel)` (`false` → `"stopped"`).
- Segment semantics: `PlaybackPlan::compile(&events, speed)`; compile error → `run_failed(…, &format!("compile-error: {e}"))`; `execute_steps(...)` returning false → `"stopped"`. `on_position` callback is a no-op in v1 (node-level events only).

- [ ] **Step 1: Failing tests.** Fakes: `ScriptedProbe { results: VecDeque<Result<bool, String>> }` (evaluate pops; empty → Ok(false)); `FakeClock { now: Arc<AtomicI64>, sleeps: Arc<Mutex<Vec<u64>>> }` — `sleep_ms` records and advances `now` by `ms`, returns `cancel.load()`; `RecordingEmitter` collecting calls as `Vec<String>` like `"started:n1"`, `"failed:n2:timeout"`.

```rust
    #[test]
    fn happy_path_runs_segment_wait_segment_in_order() {
        // wait matches on the 3rd evaluate (2 sleeps of 500ms elapse).
        // Assert emitter sequence: started/finished n1, started n2 (wait),
        // finished n2, started/finished n3, run_finished(ok=true); simulator
        // saw the key events of BOTH segments in order; sleeps == [500, 500].
    }

    #[test]
    fn timeout_aborts_run_and_skips_remaining_nodes() {
        // timeout_ms 1000, poll 500, probe always Ok(false):
        // evaluate at t=0 (no match), t>=timeout after 2 sleeps → run_failed
        // (n_wait, "timeout"); the following segment's simulate count == 0;
        // run_finished NOT emitted.
    }

    #[test]
    fn stop_during_wait_reports_stopped() {
        // FakeClock::sleep_ms stores cancel=false after first call (simulate
        // engine.stop mid-wait) → run_failed reason "stopped".
    }

    #[test]
    fn probe_error_aborts_with_evaluation_error() { /* Err("boom") → "evaluation-error: boom" */ }

    #[test]
    fn immediate_match_needs_no_sleep() { /* probe Ok(true) first; sleeps.is_empty() */ }

    #[test]
    fn runner_start_claims_and_always_releases_engine_slot() {
        // MacroRunner::start on a real PlaybackEngine with a doc whose wait
        // times out: engine.is_playing() true right after start, then poll
        // until false (≤2s); a second start afterwards succeeds.
    }
```

Write these as REAL tests (full bodies — the comments above are the specification of each body; construct docs via the Task 1 helpers pattern).

- [ ] **Step 2:** `cargo test macros::runner` → FAIL.
- [ ] **Step 3: Implement** `run_chain` + `MacroRunner::start` + `RealClock`. Every `run_failed`/`run_finished` path must be reachable exactly once per run.
- [ ] **Step 4:** full checks → PASS.
- [ ] **Step 5: Commit** `git commit -am "feat(macros): linear runner with wait gating over fake ports"`

---

### Task 5: Real WaitProbe (macOS) + extractor factoring

**Files:**
- Create: `src-tauri/src/macros/probe.rs` (macOS-gated contents)
- Modify: `src-tauri/src/perception/commands.rs` (factor), `src-tauri/src/macros/mod.rs`, `.github/workflows/test.yml`

**Interfaces:**
- Refactor in perception/commands.rs: extract the extractor-construction match into `pub(crate) fn build_extractor_with_base(kind: &TargetKind, base_dir: &Path) -> Result<Box<dyn Extractor>, String>` — TemplateMatch resolves `image` against `base_dir` (existing command passes the app data dir; behavior unchanged — existing tests stay green).
- `probe.rs`: `pub struct LiveWaitProbe { macro_dir: PathBuf, source: LiveSource }` with `pub fn new(macro_dir: PathBuf) -> Self`; `impl WaitProbe`: build extractor via `build_extractor_with_base(&target.kind, &self.macro_dir)` (macro-relative `assets/...` paths resolve under the macro's dir), grab a live frame (`source.frame_at(0)`), extract with `target.region` (`None` region → full frame `{0,0,1,1}`), map result → bool via a PURE helper in runner.rs: `pub fn result_matches(result: &ObservationResult, expect_of_text: Option<&str>) -> bool` — Text: expect None → `!spans.is_empty()`, Some(e) → any span `.text.to_lowercase().contains(&e.to_lowercase())`; Template/Color → `matched`. TextOcr targets build the ACCURATE extractor (`VisionOcr { fast: false }` — that is what `build_extractor_with_base` already constructs on macOS).
- `result_matches` lives in runner.rs (cross-platform, tested); probe.rs is thin glue → add `probe\.rs` to the CI exclusion regex: `'(permissions|ocr_macos|space_watch|probe)\.rs$'`.

- [ ] **Step 1: Failing tests** for `result_matches` (runner.rs tests): Text with expect None/empty-spans/match/case-insensitive-match/miss; Template matched/unmatched; Color matched.
- [ ] **Step 2:** RED → implement `result_matches` → GREEN.
- [ ] **Step 3:** Factor `build_extractor_with_base` (existing perception command tests must stay green — behavior-preserving refactor), implement `probe.rs`, update CI regex.
- [ ] **Step 4:** full checks → PASS.
- [ ] **Step 5: Commit** `git commit -am "feat(macros): live wait probe over the perception extractors"`

---

### Task 6: Tauri commands + TauriMacroEmitter + registration

**Files:**
- Create: `src-tauri/src/macros/commands.rs`
- Modify: `src-tauri/src/macros/mod.rs`, `src-tauri/src/lib.rs` (registration)

**Interfaces:**
- `TauriMacroEmitter { app: AppHandle }` implementing `MacroEmitter` — emits exactly: `macro-node-started` / `macro-node-finished` `{ macroId, nodeId, index }`, `macro-run-finished` `{ macroId, ok }`, `macro-run-failed` `{ macroId, nodeId, reason }` (camelCase payload structs with `#[serde(rename_all = "camelCase")]`).
- Commands (all `trace_command`-wrapped, registered in `generate_handler!`):
  - `save_macro(app, doc: MacroDoc, trace_id) -> Result<MacroDoc, String>` → `MacroStore::open(&app)?.save(doc)`
  - `load_macros(app, trace_id) -> Result<Vec<MacroDoc>, String>`
  - `delete_macro(app, id: String, trace_id) -> Result<(), String>`
  - `run_macro(app, state: State<RecordingState>, id: String, trace_id) -> Result<(), String>` — load doc by id (`Err("Macro not found")`), `MacroRunner::start(doc, &state.engine, RdevSimulator, LiveWaitProbe::new(<data_dir>/macros/<id>), RealClock, TauriMacroEmitter::new(app.clone()))`; non-macOS: `validate_runnable` inside start already rejects WaitFor docs — segment-only macros still run.
  - `stop_macro(state, trace_id) -> Result<(), String>` → `state.engine.stop()` (same as stop_playback; kept as a distinct command name for frontend clarity).
- cfg note: `LiveWaitProbe` exists only on macOS — on other platforms `run_macro` constructs a `NoWaitProbe` (always `Err("wait-unsupported")`; unreachable because validation rejected WaitFor docs first, but the type must exist to compile).

- [ ] **Step 1:** No new pure logic — the RED here is compilation + one glue test: add a `TauriMacroEmitter`-shape test? Not constructible without AppHandle — instead pin the payload structs' serde:

```rust
    #[test]
    fn event_payloads_serialize_camel_case() {
        let p = NodeEventPayload { macro_id: "m".into(), node_id: "n".into(), index: 2 };
        assert_eq!(
            serde_json::to_string(&p).unwrap(),
            r#"{"macroId":"m","nodeId":"n","index":2}"#
        );
    }
```

- [ ] **Step 2:** RED (types missing) → implement commands + emitter → GREEN. Register the five commands in lib.rs.
- [ ] **Step 3:** full checks (`cargo build` confirms registration) → PASS.
- [ ] **Step 4: Manual smoke (controller/user, not CI):** from the Studio webview devtools console:
  `await window.__TAURI__.core.invoke("save_macro", { doc: { id: "smoke1", name: "smoke", nodes: [{ id: "n1", kind: { type: "Segment", events: [...some recording's events...], speed: 1, provenance: null }, x: 0, y: 0 }], edges: [], created_at: Date.now() } })` then `invoke("run_macro", { id: "smoke1" })` — the segment replays; then add a WaitFor node targeting visible text and confirm the run pauses until the text is on screen and `macro-run-failed` fires with `"timeout"` when it isn't.
- [ ] **Step 5: Commit** `git commit -am "feat(macros): tauri command surface and run events"`

---

## Spec-coverage checklist (self-review)

- Types/serde/defaults/chain validation/typed errors → Task 1. Store, per-file parse-or-skip, asset copy + rewrite + idempotence, delete, sweep → Task 2. Engine mutual exclusion + shared stop + extract-only refactor → Task 3. Runner semantics (wait ordering, timeout boundary, stopped, evaluation-error, immediate match, slot always released) → Task 4. Match rules + accurate OCR + macro-relative asset resolution + CI exclusion → Task 5. Commands, events (exact names/payloads), non-macOS behavior, headless smoke → Task 6.
- Type consistency: `MacroNodeKind::WaitFor.target` is `perception::Target` everywhere; `run_chain` signature matches Task 4↔6 usage; `execute_steps`/`claim_for_macro` names consistent Tasks 3↔4; `result_matches` defined in runner.rs (Task 5) and used by probe.rs.
- Deferred features absent; no UI built (Task 6's smoke is devtools-only).
