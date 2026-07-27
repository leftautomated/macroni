# Reactive Rules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the linear Segment/WaitFor node-graph macro model with reactive when/then rules — a watcher-loop runtime plus a rule-deck / frame-anchored authoring UI — per `docs/superpowers/specs/2026-07-26-reactive-rules-design.md`.

**Architecture:** A `MacroDoc` becomes an ordered list of `MacroRule`s (trigger = existing `PerceptionTarget`; action = `PlayInputs` or `Stop`). The Rust runner becomes a poll loop: evaluate armed rules top-to-bottom each tick, fire the first match, edge-triggered re-arm. The frontend replaces the react-flow canvas + AddNodePanel with a RuleDeck sidebar and a TriggerPicker overlay (clickable OCR spans on the paused frame); the AuthoringDock keeps its player/timeline/In-Out machinery.

**Tech Stack:** Tauri 2 (Rust backend, serde, existing playback/perception ports), React 19 + TypeScript, Tailwind-adjacent plain CSS (`macro-editor.css` custom classes + CSS vars), vitest + @testing-library/react, cargo test.

## Global Constraints

- Biome formatting as configured in `biome.json`: **double quotes, semicolons, 2-space indent** (CLAUDE.md's "single quotes, no semicolons" note is stale — match the existing code you see).
- Type-only TS imports must use the `type` keyword: `import type { Foo } from "x"`.
- Frontend tests: `pnpm vitest run <file>`; full suite `pnpm vitest run`. Rust: `cargo test` inside `src-tauri/`. Typecheck: `pnpm tsc --noEmit` (build script runs `tsc && vite build`).
- All numeric ms values crossing IPC must be whole numbers (`Math.round`) — Rust deserializes into `i64`/`u64`.
- Tauri event payloads serialize camelCase (`#[serde(rename_all = "camelCase")]`).
- No empty-state copy anywhere in the new UI: an empty rule deck renders only the Add affordance (explicit user requirement).
- Old saved macros are NOT migrated: the store's existing parse-or-skip semantics handle them (they fail to deserialize the new shape and are skipped with a warning). Do not add migration code.
- Commit after every task with a conventional-commit message ending in the session trailer used by this repo's recent commits.

## Pre-existing building blocks (do not rebuild)

- `src-tauri/src/perception/`: `Target`, `TargetKind` (TextOcr/TemplateMatch/ColorSample), `ObservationResult`, `extract_region` command (OCRs a recording frame; spans carry **fractional full-frame regions**), `save_target` command (crops template PNG from a recording frame).
- `src-tauri/src/playback/`: `PlaybackPlan::compile(events, speed)`, `execute_steps(steps, cancel, simulator, |_|{})`, `sleep_cancellable`, engine slot claim.
- `src-tauri/src/macros/runner.rs`: port traits `WaitProbe`, `MacroClock`, `MacroEmitter`, `Simulator`; `result_matches` (keep — probe.rs uses it); `ReleaseGuard`; `MacroRunner::start` shape.
- Frontend: `StudioPlayer` (drag-to-select → `CreateTargetPopover`, `popoverKinds`, `onSaveTarget`, `onSampleColor`), `StudioTimeline` (`loop`/`onLoopChange` range drag, **`perceptionTicks` marker lane**, `rangeWord`), `AuthoringDock` (In/Out marks, Enter/Escape key handler, controlsHost), `eventsInRange`/`segmentBasis` in `macro-segment.ts`, `useVideoAssetUrl` (app-data-dir cache + `convertFileSrc`), `video-rect.ts`.

---

### Task 1: Rust backend — rules model, store, watcher runtime, commands

The four backend files form one compile unit (types are used by store/runner/commands), so this is a single task with one commit. Write the new tests alongside each file as you go; `cargo test` runs once everything compiles.

**Files:**
- Modify: `src-tauri/src/macros/mod.rs` (replace node/edge model + chain validation with rules model + rules validation)
- Modify: `src-tauri/src/macros/store.rs` (template-asset pass iterates rules; drop chain validation; allow empty-rules saves)
- Modify: `src-tauri/src/macros/runner.rs` (`run_chain`/`run_wait` → `run_rules` watcher loop; emitter trait renames)
- Modify: `src-tauri/src/macros/commands.rs` (payloads/emitter/missing_assets over rules)
- Modify (if needed): `src-tauri/src/macros/probe.rs` — only imports/type paths; probe logic unchanged
- Tests: inline `#[cfg(test)]` modules in each file (house style)

**Interfaces:**
- Consumes: `crate::perception::Target`, `crate::types::InputEvent`, playback ports (unchanged).
- Produces (later tasks and the frontend rely on these exactly):
  - Types: `MacroDoc { id, name, rules: Vec<MacroRule>, poll_interval_ms: u64 (serde default 250), created_at: i64 }`, `MacroRule { id, trigger: Target, action: RuleAction, enabled: bool (serde default true), anchor: Option<RuleAnchor> (serde default) }`, `RuleAction::PlayInputs { events, speed (default 1.0), provenance: Option<Provenance> } | RuleAction::Stop` (serde `tag = "type"`, PascalCase variants), `RuleAnchor { recording_id: String, timestamp_ms: i64 }`.
  - `validate_runnable(&MacroDoc) -> Result<(), MacroError>` with `MacroError::{NoEnabledRules, EmptyAction(String), WaitUnsupportedPlatform}`.
  - `MacroEmitter` trait: `rule_fired(&self, macro_id, rule_id, index)`, `rule_settled(&self, macro_id, rule_id, index)`, `run_finished(&self, macro_id, ok)`, `run_failed(&self, macro_id, rule_id, reason)`.
  - Tauri events: `"macro-rule-fired"` / `"macro-rule-settled"` payload `{ macroId, ruleId, index }`; `"macro-run-finished"` `{ macroId, ok }`; `"macro-run-failed"` `{ macroId, ruleId, reason }`.
  - Cancel/stop reason string stays exactly `"stopped"`.

- [ ] **Step 1: Rewrite `mod.rs` — model + validation + tests**

Replace `Provenance`-onward content (keep `Provenance` itself and the module docs/imports, minus now-unused `HashMap`):

```rust
fn default_speed() -> f64 {
    1.0
}

fn default_poll_interval_ms() -> u64 {
    250
}

fn default_true() -> bool {
    true
}

/// Links a `PlayInputs` action back to the recording range it was carved from.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Provenance {
    pub recording_id: String,
    pub start_ms: i64,
    pub end_ms: i64,
}

/// The recording frame a rule's trigger was authored on, so the editor can
/// seek back to it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RuleAnchor {
    pub recording_id: String,
    pub timestamp_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "PascalCase")]
pub enum RuleAction {
    PlayInputs {
        events: Vec<InputEvent>,
        #[serde(default = "default_speed")]
        speed: f64,
        provenance: Option<Provenance>,
    },
    Stop,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MacroRule {
    pub id: String,
    pub trigger: Target,
    pub action: RuleAction,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub anchor: Option<RuleAnchor>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MacroDoc {
    pub id: String,
    pub name: String,
    pub rules: Vec<MacroRule>,
    #[serde(default = "default_poll_interval_ms")]
    pub poll_interval_ms: u64,
    pub created_at: i64,
}

#[derive(Debug, PartialEq)]
#[allow(dead_code)] // WaitUnsupportedPlatform only constructed off-macOS
pub enum MacroError {
    NoEnabledRules,
    EmptyAction(String),
    WaitUnsupportedPlatform,
}

impl std::fmt::Display for MacroError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MacroError::NoEnabledRules => write!(f, "Macro has no enabled rules"),
            MacroError::EmptyAction(id) => write!(f, "Rule '{id}' plays no events"),
            MacroError::WaitUnsupportedPlatform => {
                write!(f, "Reactive macros require macOS")
            }
        }
    }
}

/// Runnable = at least one enabled rule, every enabled PlayInputs rule has
/// events, and (off macOS) never — every rule needs the perception probe.
pub fn validate_runnable(doc: &MacroDoc) -> Result<(), MacroError> {
    let enabled: Vec<&MacroRule> = doc.rules.iter().filter(|r| r.enabled).collect();
    if enabled.is_empty() {
        return Err(MacroError::NoEnabledRules);
    }
    for rule in &enabled {
        if let RuleAction::PlayInputs { events, .. } = &rule.action {
            if events.is_empty() {
                return Err(MacroError::EmptyAction(rule.id.clone()));
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        return Err(MacroError::WaitUnsupportedPlatform);
    }
    #[cfg(target_os = "macos")]
    Ok(())
}
```

Delete `chain_order`, `MacroNode`, `MacroNodeKind`, `MacroEdge`, `default_timeout_ms`, and the whole old test module. Update the module doc comment to describe the reactive model. New tests (same house style as the old ones — build tiny docs with helper fns):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::perception::{Modality, Region, Target, TargetKind};
    use crate::types::InputEvent;

    fn text_trigger(id: &str) -> Target {
        Target {
            id: id.into(),
            name: "t".into(),
            modality: Modality::Visual,
            region: Some(Region { x: 0.1, y: 0.1, w: 0.2, h: 0.05 }),
            kind: TargetKind::TextOcr { expect: Some("Go".into()) },
            created_at: 1,
        }
    }

    fn play_rule(id: &str) -> MacroRule {
        MacroRule {
            id: id.into(),
            trigger: text_trigger("t1"),
            action: RuleAction::PlayInputs {
                events: vec![InputEvent::KeyPress { key: "A".into(), timestamp: 0 }],
                speed: 1.0,
                provenance: None,
            },
            enabled: true,
            anchor: None,
        }
    }

    fn doc(rules: Vec<MacroRule>) -> MacroDoc {
        MacroDoc { id: "m1".into(), name: "test".into(), rules, poll_interval_ms: 250, created_at: 1 }
    }

    #[test]
    fn serde_round_trips_with_tagging_and_defaults() {
        let d = doc(vec![play_rule("r1")]);
        let json = serde_json::to_string(&d).unwrap();
        assert!(json.contains("\"type\":\"PlayInputs\""), "{json}");
        let back: MacroDoc = serde_json::from_str(&json).unwrap();
        assert_eq!(back, d);
        // enabled / anchor / poll_interval_ms default when omitted.
        let minimal = r#"{"id":"m","name":"n","created_at":1,"rules":[{"id":"r","trigger":{"id":"t","name":"n","modality":"visual","region":null,"kind":{"type":"TextOcr","expect":"Go"},"created_at":1},"action":{"type":"Stop"}}]}"#;
        let back: MacroDoc = serde_json::from_str(minimal).unwrap();
        assert_eq!(back.poll_interval_ms, 250);
        assert!(back.rules[0].enabled);
        assert!(back.rules[0].anchor.is_none());
    }

    #[test]
    fn old_node_graph_docs_fail_to_deserialize() {
        let old = r#"{"id":"m","name":"n","nodes":[],"edges":[],"created_at":1}"#;
        assert!(serde_json::from_str::<MacroDoc>(old).is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn validate_requires_an_enabled_rule_with_events() {
        assert_eq!(validate_runnable(&doc(vec![])), Err(MacroError::NoEnabledRules));
        let mut disabled = play_rule("r1");
        disabled.enabled = false;
        assert_eq!(validate_runnable(&doc(vec![disabled])), Err(MacroError::NoEnabledRules));
        let mut empty = play_rule("r2");
        empty.action = RuleAction::PlayInputs { events: vec![], speed: 1.0, provenance: None };
        assert_eq!(
            validate_runnable(&doc(vec![empty])),
            Err(MacroError::EmptyAction("r2".into()))
        );
        assert_eq!(validate_runnable(&doc(vec![play_rule("r3")])), Ok(()));
        // A Stop-only doc is technically runnable (silly but harmless).
        let stop = MacroRule {
            id: "s".into(),
            trigger: text_trigger("t"),
            action: RuleAction::Stop,
            enabled: true,
            anchor: None,
        };
        assert_eq!(validate_runnable(&doc(vec![stop])), Ok(()));
    }

    #[test]
    fn error_display_strings_are_stable() {
        assert_eq!(MacroError::NoEnabledRules.to_string(), "Macro has no enabled rules");
        assert_eq!(MacroError::EmptyAction("x".into()).to_string(), "Rule 'x' plays no events");
        assert_eq!(
            MacroError::WaitUnsupportedPlatform.to_string(),
            "Reactive macros require macOS"
        );
    }
}
```

- [ ] **Step 2: Rewrite `store.rs` save/asset pass over rules**

In `save()`: drop the `chain_order` import/call. Keep `validate_storage_id(&doc.id)`. Both passes now iterate rules — every rule's trigger id is validated; only `TemplateMatch` triggers get the copy/rewrite:

```rust
// Pass 1: no side effects.
for rule in &doc.rules {
    validate_storage_id(&rule.trigger.id)?;
    let TargetKind::TemplateMatch { image, .. } = &rule.trigger.kind else {
        continue;
    };
    if image.starts_with(ASSETS_PREFIX) {
        continue; // already macro-relative: idempotent re-save.
    }
    if !is_safe_relative_path(image) {
        return Err("invalid template path".to_string());
    }
    let source = self.data_dir.join(image);
    if !source.exists() {
        return Err(format!("template image not found: {}", source.display()));
    }
}

// Pass 2: copy + rewrite.
for rule in &mut doc.rules {
    let target = &mut rule.trigger;
    let TargetKind::TemplateMatch { image, .. } = &mut target.kind else {
        continue;
    };
    if image.starts_with(ASSETS_PREFIX) {
        continue;
    }
    let source = self.data_dir.join(&image);
    let assets_dir = self.assets_dir(&doc.id);
    std::fs::create_dir_all(&assets_dir).map_err(|e| e.to_string())?;
    let dest = assets_dir.join(format!("{}.png", target.id));
    std::fs::copy(&source, &dest).map_err(|e| e.to_string())?;
    *image = format!("{ASSETS_PREFIX}{}.png", target.id);
}
```

Note: an empty-rules doc now saves successfully (draft saving; the old model rejected empty docs via chain_order). Update the store tests: helper `seg_doc` → `rules_doc(id)` building a one-`play_rule` doc; template tests use a rule whose `trigger.kind` is TemplateMatch; keep all traversal/atomicity tests (same assertions, rules-shaped fixtures); add:

```rust
#[test]
fn save_accepts_an_empty_rules_doc() {
    let dir = tempdir().unwrap();
    let store = MacroStore::open_at(dir.path().to_path_buf());
    let d = MacroDoc { id: "empty".into(), name: "m".into(), rules: vec![], poll_interval_ms: 250, created_at: 1 };
    store.save(d).unwrap();
    assert!(dir.path().join("macros/empty.json").exists());
}

#[test]
fn load_all_skips_old_node_graph_docs() {
    let dir = tempdir().unwrap();
    let store = MacroStore::open_at(dir.path().to_path_buf());
    store.save(rules_doc("new1")).unwrap();
    std::fs::write(
        dir.path().join("macros/old.json"),
        br#"{"id":"old","name":"o","nodes":[],"edges":[],"created_at":1}"#,
    )
    .unwrap();
    let all = store.load_all();
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].id, "new1");
}
```

- [ ] **Step 3: Rewrite `runner.rs` — `MacroEmitter` renames + `run_rules` watcher loop**

Keep: `WaitProbe`, `result_matches` (+ its tests), `MacroClock`, `RealClock`, `ReleaseGuard`, `MacroRunner::start` (only the inner call changes to `run_rules`). Replace the `MacroEmitter` trait methods and `run_chain`/`run_wait`:

```rust
/// UI/telemetry sink for run progress. Every run emits exactly one terminal
/// event: `run_finished` on success (Stop rule fired), `run_failed` on any
/// abort (manual stop, probe error, compile error).
pub trait MacroEmitter: Send + 'static {
    fn rule_fired(&self, macro_id: &str, rule_id: &str, index: usize);
    fn rule_settled(&self, macro_id: &str, rule_id: &str, index: usize);
    fn run_finished(&self, macro_id: &str, ok: bool);
    fn run_failed(&self, macro_id: &str, rule_id: &str, reason: &str);
}

/// Reactive watcher loop. Each tick evaluates enabled rules top-to-bottom
/// (list order = priority) and fires the first ARMED match:
///   - `PlayInputs`: replay the rule's events, then disarm it. It re-arms
///     only after a later tick observes its trigger NOT matching
///     (edge-trigger, so a persistent prompt can't re-fire in a loop).
///   - `Stop`: end the run successfully.
/// The run ends via a Stop rule, manual cancel ("stopped"), or a probe /
/// compile error. There are no per-rule timeouts.
pub fn run_rules(
    doc: &MacroDoc,
    cancel: &AtomicBool,
    simulator: &impl Simulator,
    probe: &mut impl WaitProbe,
    clock: &impl MacroClock,
    emitter: &impl MacroEmitter,
) -> Result<(), ()> {
    let macro_id = doc.id.as_str();
    let rules: Vec<&MacroRule> = doc.rules.iter().filter(|r| r.enabled).collect();
    if rules.is_empty() {
        // Pre-validated by MacroRunner::start; still emit one terminal event
        // so a malformed direct call can't end silently.
        emitter.run_failed(macro_id, "", &MacroError::NoEnabledRules.to_string());
        return Err(());
    }
    let mut armed = vec![true; rules.len()];

    loop {
        if !cancel.load(Ordering::Relaxed) {
            emitter.run_failed(macro_id, "", "stopped");
            return Err(());
        }

        // Evaluate top-to-bottom; stop at the first armed match. Rules seen
        // NOT matching re-arm; rules after a fired one keep their state.
        let mut fired: Option<usize> = None;
        for (i, rule) in rules.iter().enumerate() {
            match probe.evaluate(&rule.trigger) {
                Err(e) => {
                    emitter.run_failed(macro_id, &rule.id, &format!("evaluation-error: {e}"));
                    return Err(());
                }
                Ok(true) => {
                    if armed[i] {
                        fired = Some(i);
                        break;
                    }
                }
                Ok(false) => armed[i] = true,
            }
        }

        if let Some(i) = fired {
            let rule = rules[i];
            emitter.rule_fired(macro_id, &rule.id, i);
            match &rule.action {
                RuleAction::Stop => {
                    emitter.rule_settled(macro_id, &rule.id, i);
                    emitter.run_finished(macro_id, true);
                    return Ok(());
                }
                RuleAction::PlayInputs { events, speed, .. } => {
                    let plan = match PlaybackPlan::compile(events, *speed) {
                        Ok(plan) => plan,
                        Err(e) => {
                            emitter.run_failed(macro_id, &rule.id, &format!("compile-error: {e}"));
                            return Err(());
                        }
                    };
                    let completed = execute_steps(&plan.steps, cancel, simulator, |_| {});
                    if !completed {
                        emitter.run_failed(macro_id, &rule.id, "stopped");
                        return Err(());
                    }
                    armed[i] = false;
                    emitter.rule_settled(macro_id, &rule.id, i);
                }
            }
        }

        if !clock.sleep_ms(doc.poll_interval_ms.max(100), cancel) {
            emitter.run_failed(macro_id, "", "stopped");
            return Err(());
        }
    }
}
```

Update imports (`use super::{validate_runnable, MacroDoc, MacroError, MacroRule, RuleAction};`) and `MacroRunner::start`'s spawn body to call `run_rules`. Module doc comment updated to describe the watcher loop.

- [ ] **Step 4: Rewrite the runner test module**

Adapt the existing fakes (they're already there: scripted `WaitProbe` off a `VecDeque`, recording emitter, virtual clock, no-op simulator) to the new trait names, then cover — each as its own `#[test]`:

1. **Priority:** two rules, probe scripted so BOTH match on tick 1 → only rule[0] fires (`rule_fired` ids recorded == `["r1"]` after one tick).
2. **Edge-triggered re-arm:** one rule; probe script `[true, true, false, true]` → fires on ticks 1 and 4 only (2 `rule_fired` events total).
3. **Persistent match never re-fires:** probe script `[true, true, true]` then cancel → exactly 1 `rule_fired`.
4. **Disabled rules skipped:** rule[0] disabled, rule[1] enabled, both scripted true → only rule[1] fires and probe is never asked about rule[0]'s target (script per-target).
5. **Stop rule:** rule with `RuleAction::Stop` scripted true → `rule_fired` + `rule_settled` + `run_finished(ok=true)`, `run_rules` returns `Ok(())`.
6. **Manual cancel during sleep:** clock's `sleep_ms` returns false → `run_failed(_, "", "stopped")`, `Err(())`.
7. **Cancel flag already false at tick start:** → `run_failed(_, "", "stopped")`.
8. **Probe error:** `evaluate` returns `Err("boom")` → `run_failed(_, rule_id, "evaluation-error: boom")`.
9. **Empty/enabled-empty doc:** direct `run_rules` call → `run_failed(_, "", "Macro has no enabled rules")`.
10. **PlayInputs replays through the simulator then disarms:** rule scripted `[true, false, true]` with 1 event → simulator records 1 simulate on tick 1, re-fires tick 3 → 2 total.
11. Keep the existing `MacroRunner::start` engine-slot tests, adapted to a rules doc (start rejects invalid docs; slot released after run).

Multi-rule probe scripting: key the fake probe's scripts by `target.id` (each rule gets a distinct trigger id), e.g. `HashMap<String, VecDeque<Result<bool, String>>>`; a missing script entry returns `Ok(false)`.

- [ ] **Step 5: Rewrite `commands.rs` payloads + emitter + missing_assets**

```rust
/// Shared payload shape for `macro-rule-fired` / `macro-rule-settled`.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuleEventPayload {
    macro_id: String,
    rule_id: String,
    index: usize,
}

/// Payload for `macro-run-failed`.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RunFailedPayload {
    macro_id: String,
    rule_id: String,
    reason: String,
}
```

`TauriMacroEmitter` implements the renamed trait, emitting `"macro-rule-fired"`, `"macro-rule-settled"`, `"macro-run-finished"` (payload unchanged), `"macro-run-failed"`. `missing_assets` iterates `doc.rules` / `rule.trigger.kind`. `run_macro`/`save_macro`/`load_macros`/`delete_macro`/`stop_macro` bodies otherwise unchanged (imports: `use crate::macros::MacroDoc;` — `MacroNodeKind` no longer exists). Update this file's tests: fixtures become rules docs; payload serde tests assert `{"macroId":"m","ruleId":"r","index":2}` and `{"macroId":"m","ruleId":"r","reason":"timeout"}` shapes.

- [ ] **Step 6: Compile + fix stragglers**

Run: `cargo build 2>&1 | head -50` in `src-tauri/`. Fix any remaining references (check `lib.rs`, `probe.rs` — probe implements `WaitProbe` and shouldn't change beyond imports). Expected: clean build.

- [ ] **Step 7: Run the backend suite**

Run: `cargo test` in `src-tauri/`. Expected: PASS, including all new mod/store/runner/commands tests.

- [ ] **Step 8: Commit**

```bash
git add src-tauri && git commit -m "feat(macros): reactive rules model and watcher runtime replacing linear chains"
```

---

### Task 2: Frontend types + `macro-rules.ts` utilities (additive — old canvas keeps compiling)

**Files:**
- Modify: `src/types.ts` (ADD rule types; do NOT remove node/edge types or change `MacroDoc` yet — that happens in Task 5)
- Create: `src/lib/macro-rules.ts`
- Test: `src/lib/macro-rules.test.ts`

**Interfaces:**
- Consumes: `PerceptionTarget`, `TextSpan`, `InputEvent`, `Recording`, `MacroProvenance` from `@/types`; `eventsInRange`, `segmentBasis` from `@/lib/macro-segment`; `LoopRegion` from `@/components/studio/StudioTimeline`.
- Produces (Tasks 3–5 rely on these exact signatures):

```ts
// types.ts additions
export interface RuleAnchor { recording_id: string; timestamp_ms: number }
export type RuleAction =
  | { type: "PlayInputs"; events: InputEvent[]; speed: number; provenance?: MacroProvenance | null }
  | { type: "Stop" };
export interface MacroRule {
  id: string;
  trigger: PerceptionTarget;
  action: RuleAction;
  enabled: boolean;
  anchor?: RuleAnchor | null;
}

// macro-rules.ts — all pure. `RulesDoc` is the structural slice so these work
// before MacroDoc flips shape in Task 5.
export interface RulesDoc { rules: MacroRule[] }
export function spanTrigger(span: TextSpan): PerceptionTarget;
export function playInputsRule(trigger: PerceptionTarget, recording: Recording, anchorMs: number, startMs: number, endMs: number): MacroRule;
export function stopRule(trigger: PerceptionTarget, recordingId: string, anchorMs: number): MacroRule;
export function ruleSummary(rule: MacroRule): string;      // "17 events · 8.2s" | "Stop macro"
export function triggerLabel(target: PerceptionTarget): string; // '"climb the stairs"' | name fallback
export function isRunnableRulesDoc(doc: RulesDoc): boolean;
export function moveRule<T extends RulesDoc>(doc: T, ruleId: string, delta: -1 | 1): T;
export function toggleRule<T extends RulesDoc>(doc: T, ruleId: string): T;
export function removeRule<T extends RulesDoc>(doc: T, ruleId: string): T;
export function defaultActionRange(doc: RulesDoc, recordingId: string, anchorMs: number, durationMs: number): LoopRegion | null;
export function anchorTicks(doc: RulesDoc, recordingId: string): Array<{ ms: number; label: string }>;
```

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";
import {
  anchorTicks,
  defaultActionRange,
  isRunnableRulesDoc,
  moveRule,
  playInputsRule,
  removeRule,
  ruleSummary,
  spanTrigger,
  stopRule,
  toggleRule,
  triggerLabel,
} from "@/lib/macro-rules";
import { InputEventType, type MacroRule, type Recording, type TextSpan } from "@/types";

const span: TextSpan = {
  text: "climb the stairs",
  region: { x: 0.4, y: 0.2, w: 0.2, h: 0.04 },
  confidence: 0.95,
};

const recording: Recording = {
  id: "rec1",
  name: "run",
  created_at: 0,
  playback_speed: 1,
  events: [
    { type: InputEventType.KeyPress, key: "A", timestamp: 1000 },
    { type: InputEventType.KeyPress, key: "B", timestamp: 2000 },
    { type: InputEventType.KeyPress, key: "C", timestamp: 9000 },
  ],
  video: { path: "v.mp4", duration_ms: 10000, fps: 30, width: 100, height: 100, start_ms: 0 },
};

describe("spanTrigger", () => {
  it("builds a TextOcr target scoped to the padded span box", () => {
    const t = spanTrigger(span);
    expect(t.kind).toEqual({ type: "TextOcr", expect: "climb the stairs" });
    expect(t.name).toBe("climb the stairs");
    // Padded by 0.01 on each side, clamped to [0,1].
    expect(t.region).toEqual({ x: 0.39, y: 0.19, w: 0.22, h: 0.06 });
  });

  it("clamps padding at the frame edges", () => {
    const edge = spanTrigger({ ...span, region: { x: 0, y: 0.99, w: 1, h: 0.01 } });
    expect(edge.region?.x).toBe(0);
    expect(edge.region?.y).toBeCloseTo(0.98);
    expect((edge.region?.x ?? 0) + (edge.region?.w ?? 0)).toBeLessThanOrEqual(1);
    expect((edge.region?.y ?? 0) + (edge.region?.h ?? 0)).toBeLessThanOrEqual(1);
  });
});

describe("rule builders", () => {
  it("playInputsRule carves events in [startMs, endMs] with provenance and anchor", () => {
    const rule = playInputsRule(spanTrigger(span), recording, 500, 1000, 2500);
    expect(rule.action.type).toBe("PlayInputs");
    if (rule.action.type !== "PlayInputs") return;
    expect(rule.action.events).toHaveLength(2);
    expect(rule.action.provenance).toEqual({ recording_id: "rec1", start_ms: 1000, end_ms: 2500 });
    expect(rule.anchor).toEqual({ recording_id: "rec1", timestamp_ms: 500 });
    expect(rule.enabled).toBe(true);
  });

  it("playInputsRule rounds fractional ms", () => {
    const rule = playInputsRule(spanTrigger(span), recording, 500.4, 999.6, 2500.2);
    expect(rule.anchor?.timestamp_ms).toBe(500);
    if (rule.action.type !== "PlayInputs") return;
    expect(rule.action.provenance?.start_ms).toBe(1000);
    expect(rule.action.provenance?.end_ms).toBe(2500);
  });

  it("stopRule has a Stop action and an anchor", () => {
    const rule = stopRule(spanTrigger(span), "rec1", 700);
    expect(rule.action).toEqual({ type: "Stop" });
    expect(rule.anchor).toEqual({ recording_id: "rec1", timestamp_ms: 700 });
  });
});

describe("summaries", () => {
  it("summarizes PlayInputs as count and duration", () => {
    const rule = playInputsRule(spanTrigger(span), recording, 0, 1000, 9000);
    expect(ruleSummary(rule)).toBe("3 events · 8s");
  });
  it("summarizes Stop", () => {
    expect(ruleSummary(stopRule(spanTrigger(span), "rec1", 0))).toBe("Stop macro");
  });
  it("labels a text trigger by its expect text", () => {
    expect(triggerLabel(spanTrigger(span))).toBe('"climb the stairs"');
  });
});

describe("doc utilities", () => {
  const r1 = playInputsRule(spanTrigger(span), recording, 100, 1000, 2500);
  const r2 = stopRule(spanTrigger(span), "rec1", 5000);
  const doc = { rules: [r1, r2] };

  it("isRunnableRulesDoc requires an enabled rule with events", () => {
    expect(isRunnableRulesDoc({ rules: [] })).toBe(false);
    expect(isRunnableRulesDoc({ rules: [{ ...r1, enabled: false }] })).toBe(false);
    const empty: MacroRule = {
      ...r1,
      action: { type: "PlayInputs", events: [], speed: 1, provenance: null },
    };
    expect(isRunnableRulesDoc({ rules: [empty] })).toBe(false);
    expect(isRunnableRulesDoc(doc)).toBe(true);
  });

  it("moveRule reorders and clamps at the edges", () => {
    expect(moveRule(doc, r2.id, -1).rules.map((r) => r.id)).toEqual([r2.id, r1.id]);
    expect(moveRule(doc, r1.id, -1).rules.map((r) => r.id)).toEqual([r1.id, r2.id]);
  });

  it("toggleRule flips enabled; removeRule drops the rule", () => {
    expect(toggleRule(doc, r1.id).rules[0].enabled).toBe(false);
    expect(removeRule(doc, r1.id).rules.map((r) => r.id)).toEqual([r2.id]);
  });

  it("defaultActionRange runs from the anchor to the next anchor on the same recording", () => {
    expect(defaultActionRange(doc, "rec1", 100, 10000)).toEqual({ a: 100, b: 5000 });
    expect(defaultActionRange(doc, "rec1", 5000, 10000)).toEqual({ a: 5000, b: 10000 });
    expect(defaultActionRange(doc, "rec1", 9999.4, 10000)).toEqual({ a: 9999, b: 10000 });
    // Anchor at the very end → no valid range.
    expect(defaultActionRange(doc, "rec1", 10000, 10000)).toBeNull();
  });

  it("anchorTicks lists anchors for the recording with trigger labels", () => {
    expect(anchorTicks(doc, "rec1")).toEqual([
      { ms: 100, label: '"climb the stairs"' },
      { ms: 5000, label: '"climb the stairs"' },
    ]);
    expect(anchorTicks(doc, "other")).toEqual([]);
  });
});
```

(`InputEvent` variants use the `InputEventType` string enum — `{ type: InputEventType.KeyPress, key, timestamp }` — verified against `src/types.ts:8-34`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/lib/macro-rules.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

Add the types to `types.ts` (leave `MacroNode`/`MacroNodeKind`/`MacroEdge`/`MacroDoc` untouched for now). Implement `macro-rules.ts`:

```ts
import type { LoopRegion } from "@/components/studio/StudioTimeline";
import { eventsInRange, segmentBasis } from "@/lib/macro-segment";
import type { MacroRule, PerceptionTarget, Recording, TextSpan } from "@/types";

export interface RulesDoc {
  rules: MacroRule[];
}

const SPAN_PAD = 0.01;

/** TextOcr trigger scoped to a detected span's box, padded and clamped. */
export function spanTrigger(span: TextSpan): PerceptionTarget {
  const x = Math.max(0, span.region.x - SPAN_PAD);
  const y = Math.max(0, span.region.y - SPAN_PAD);
  const w = Math.min(1 - x, span.region.w + 2 * SPAN_PAD);
  const h = Math.min(1 - y, span.region.h + 2 * SPAN_PAD);
  return {
    id: crypto.randomUUID(),
    name: span.text,
    modality: "visual",
    region: { x, y, w, h },
    kind: { type: "TextOcr", expect: span.text },
    created_at: Date.now(),
  };
}

export function playInputsRule(
  trigger: PerceptionTarget,
  recording: Recording,
  anchorMs: number,
  startMs: number,
  endMs: number,
): MacroRule {
  const rStart = Math.round(startMs);
  const rEnd = Math.round(endMs);
  const events = eventsInRange(recording.events, segmentBasis(recording), rStart, rEnd);
  return {
    id: crypto.randomUUID(),
    trigger,
    action: {
      type: "PlayInputs",
      events,
      speed: 1,
      provenance: { recording_id: recording.id, start_ms: rStart, end_ms: rEnd },
    },
    enabled: true,
    anchor: { recording_id: recording.id, timestamp_ms: Math.round(anchorMs) },
  };
}

export function stopRule(
  trigger: PerceptionTarget,
  recordingId: string,
  anchorMs: number,
): MacroRule {
  return {
    id: crypto.randomUUID(),
    trigger,
    action: { type: "Stop" },
    enabled: true,
    anchor: { recording_id: recordingId, timestamp_ms: Math.round(anchorMs) },
  };
}

export function ruleSummary(rule: MacroRule): string {
  if (rule.action.type === "Stop") return "Stop macro";
  const { events } = rule.action;
  let dur = 0;
  if (events.length >= 2) {
    const first = events[0];
    const last = events[events.length - 1];
    dur = Math.round(((last.timestamp - first.timestamp) / 1000) * 10) / 10;
  }
  return `${events.length} events · ${dur}s`;
}

export function triggerLabel(target: PerceptionTarget): string {
  if (target.kind.type === "TextOcr" && target.kind.expect) return `"${target.kind.expect}"`;
  return target.name || target.id;
}

export function isRunnableRulesDoc(doc: RulesDoc): boolean {
  const enabled = doc.rules.filter((r) => r.enabled);
  if (enabled.length === 0) return false;
  return enabled.every((r) => r.action.type !== "PlayInputs" || r.action.events.length > 0);
}

export function moveRule<T extends RulesDoc>(doc: T, ruleId: string, delta: -1 | 1): T {
  const index = doc.rules.findIndex((r) => r.id === ruleId);
  const to = index + delta;
  if (index === -1 || to < 0 || to >= doc.rules.length) return doc;
  const rules = [...doc.rules];
  const [moved] = rules.splice(index, 1);
  rules.splice(to, 0, moved);
  return { ...doc, rules };
}

export function toggleRule<T extends RulesDoc>(doc: T, ruleId: string): T {
  return {
    ...doc,
    rules: doc.rules.map((r) => (r.id === ruleId ? { ...r, enabled: !r.enabled } : r)),
  };
}

export function removeRule<T extends RulesDoc>(doc: T, ruleId: string): T {
  return { ...doc, rules: doc.rules.filter((r) => r.id !== ruleId) };
}

/**
 * Pre-selected action range for a new rule: from the anchor to the next
 * rule anchor on the same recording, else the recording end. Null when the
 * anchor leaves no room (at/after the end).
 */
export function defaultActionRange(
  doc: RulesDoc,
  recordingId: string,
  anchorMs: number,
  durationMs: number,
): LoopRegion | null {
  const a = Math.round(anchorMs);
  const laterAnchors = doc.rules
    .map((r) => r.anchor)
    .filter((an): an is NonNullable<typeof an> => !!an && an.recording_id === recordingId)
    .map((an) => an.timestamp_ms)
    .filter((ms) => ms > a);
  const b = Math.round(laterAnchors.length > 0 ? Math.min(...laterAnchors) : durationMs);
  return b > a ? { a, b } : null;
}

/** Timeline tick markers for every rule anchored on `recordingId`. */
export function anchorTicks(
  doc: RulesDoc,
  recordingId: string,
): Array<{ ms: number; label: string }> {
  return doc.rules
    .filter((r) => r.anchor?.recording_id === recordingId)
    .map((r) => ({
      ms: r.anchor?.timestamp_ms ?? 0,
      label: triggerLabel(r.trigger),
    }))
    .sort((x, y) => x.ms - y.ms);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/lib/macro-rules.test.ts` — Expected: PASS. Also `pnpm tsc --noEmit` — Expected: clean (old canvas untouched).

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/lib/macro-rules.ts src/lib/macro-rules.test.ts
git commit -m "feat(macros): rule types and pure rule-doc utilities"
```

---

### Task 3: RuleDeck + RuleCard components (additive, unwired)

**Files:**
- Create: `src/components/studio/macros/RuleCard.tsx`
- Create: `src/components/studio/macros/RuleDeck.tsx`
- Modify: `src/components/studio/macros/macro-editor.css` (append `.rd-*` / `.rc-*` styles)
- Test: `src/components/studio/macros/RuleDeck.test.tsx`

**Interfaces:**
- Consumes: `MacroRule` from `@/types`; `ruleSummary`, `triggerLabel` from `@/lib/macro-rules`.
- Produces:

```tsx
export interface RuleCardProps {
  rule: MacroRule;
  index: number;
  count: number;
  live: boolean;      // this rule is currently firing
  failedReason: string | null; // non-null → failed styling + reason line
  watching: boolean;  // run in progress and rule enabled
  onSelect: (ruleId: string) => void;
  onToggle: (ruleId: string) => void;
  onDelete: (ruleId: string) => void;
  onMove: (ruleId: string, delta: -1 | 1) => void;
}

export interface RuleDeckProps {
  rules: MacroRule[];
  liveRuleId: string | null;
  failed: { ruleId: string; reason: string } | null;
  running: boolean;
  draft: ReactNode | null;   // draft card slot, rendered pinned at the top
  onAddRule: () => void;
  onSelect: (ruleId: string) => void;
  onToggle: (ruleId: string) => void;
  onDelete: (ruleId: string) => void;
  onMove: (ruleId: string, delta: -1 | 1) => void;
}
```

- [ ] **Step 1: Write the failing tests**

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RuleDeck } from "@/components/studio/macros/RuleDeck";
import { InputEventType, type MacroRule } from "@/types";

function rule(id: string, overrides: Partial<MacroRule> = {}): MacroRule {
  return {
    id,
    trigger: {
      id: `t-${id}`,
      name: "climb the stairs",
      modality: "visual",
      region: { x: 0.4, y: 0.2, w: 0.2, h: 0.05 },
      kind: { type: "TextOcr", expect: "climb the stairs" },
      created_at: 1,
    },
    action: {
      type: "PlayInputs",
      events: [
        { type: InputEventType.KeyPress, key: "A", timestamp: 0 },
        { type: InputEventType.KeyPress, key: "B", timestamp: 8200 },
      ],
      speed: 1,
      provenance: null,
    },
    enabled: true,
    anchor: { recording_id: "rec1", timestamp_ms: 100 },
    ...overrides,
  };
}

const noHandlers = {
  onAddRule: vi.fn(),
  onSelect: vi.fn(),
  onToggle: vi.fn(),
  onDelete: vi.fn(),
  onMove: vi.fn(),
};

describe("RuleDeck", () => {
  it("renders one sentence card per rule", () => {
    render(
      <RuleDeck
        rules={[rule("r1"), rule("r2", { action: { type: "Stop" } })]}
        liveRuleId={null}
        failed={null}
        running={false}
        draft={null}
        {...noHandlers}
      />,
    );
    expect(screen.getAllByText(/"climb the stairs"/)).toHaveLength(2);
    expect(screen.getByText("2 events · 8.2s")).toBeInTheDocument();
    expect(screen.getByText("Stop macro")).toBeInTheDocument();
  });

  it("renders NO empty-state copy when there are no rules — only the Add affordance", () => {
    const { container } = render(
      <RuleDeck rules={[]} liveRuleId={null} failed={null} running={false} draft={null} {...noHandlers} />,
    );
    expect(screen.getByRole("button", { name: /add rule/i })).toBeInTheDocument();
    // The deck body contains nothing but the add button — no copy nodes.
    expect(container.querySelectorAll(".rc-root")).toHaveLength(0);
    expect(container.textContent?.toLowerCase()).not.toContain("no rules");
    expect(container.textContent?.toLowerCase()).not.toContain("empty");
  });

  it("wires card actions: select, toggle, delete, move", () => {
    const onSelect = vi.fn();
    const onToggle = vi.fn();
    const onDelete = vi.fn();
    const onMove = vi.fn();
    render(
      <RuleDeck
        rules={[rule("r1"), rule("r2")]}
        liveRuleId={null}
        failed={null}
        running={false}
        draft={null}
        onAddRule={vi.fn()}
        onSelect={onSelect}
        onToggle={onToggle}
        onDelete={onDelete}
        onMove={onMove}
      />,
    );
    fireEvent.click(screen.getAllByText(/"climb the stairs"/)[0]);
    expect(onSelect).toHaveBeenCalledWith("r1");
    fireEvent.click(screen.getAllByRole("switch", { name: /enabled/i })[0]);
    expect(onToggle).toHaveBeenCalledWith("r1");
    fireEvent.click(screen.getAllByRole("button", { name: /delete rule/i })[1]);
    expect(onDelete).toHaveBeenCalledWith("r2");
    fireEvent.click(screen.getAllByRole("button", { name: /move down/i })[0]);
    expect(onMove).toHaveBeenCalledWith("r1", 1);
  });

  it("disables move-up on the first card and move-down on the last", () => {
    render(
      <RuleDeck rules={[rule("r1"), rule("r2")]} liveRuleId={null} failed={null} running={false} draft={null} {...noHandlers} />,
    );
    expect(screen.getAllByRole("button", { name: /move up/i })[0]).toBeDisabled();
    expect(screen.getAllByRole("button", { name: /move down/i })[1]).toBeDisabled();
  });

  it("flags live, failed, and watching states on the right cards", () => {
    render(
      <RuleDeck
        rules={[rule("r1"), rule("r2")]}
        liveRuleId="r1"
        failed={{ ruleId: "r2", reason: "evaluation-error: boom" }}
        running={true}
        draft={null}
        {...noHandlers}
      />,
    );
    const cards = document.querySelectorAll(".rc-root");
    expect(cards[0].getAttribute("data-live")).toBe("true");
    expect(cards[1].getAttribute("data-failed")).toBe("true");
    expect(screen.getByText(/evaluation-error: boom/)).toBeInTheDocument();
  });

  it("renders the draft slot above the cards when provided", () => {
    render(
      <RuleDeck rules={[rule("r1")]} liveRuleId={null} failed={null} running={false} draft={<div data-testid="draft" />} {...noHandlers} />,
    );
    expect(screen.getByTestId("draft")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run src/components/studio/macros/RuleDeck.test.tsx` → FAIL (module not found).

- [ ] **Step 3: Implement RuleCard + RuleDeck**

`RuleCard.tsx` — sentence card. Trigger badge by kind: TextOcr → `ScanText` icon + `triggerLabel`; TemplateMatch → `Image` icon + target name; ColorSample → inline swatch `<span className="rc-swatch" style={{ background: rgb(...) }} />` + name. Structure:

```tsx
import { ChevronDown, ChevronUp, Image, ScanText, Trash2 } from "lucide-react";
import { ruleSummary, triggerLabel } from "@/lib/macro-rules";
import { Switch } from "@/components/ui/switch";
import type { MacroRule } from "@/types";

export function RuleCard({ rule, index, count, live, failedReason, watching, onSelect, onToggle, onDelete, onMove }: RuleCardProps) {
  const kind = rule.trigger.kind;
  return (
    <div
      className="rc-root"
      data-live={live || undefined}
      data-failed={failedReason ? true : undefined}
      data-watching={watching || undefined}
      data-disabled={!rule.enabled || undefined}
    >
      <button type="button" className="rc-body" onClick={() => onSelect(rule.id)}>
        <span className="rc-when">
          {kind.type === "TextOcr" && <ScanText aria-hidden="true" />}
          {kind.type === "TemplateMatch" && <Image aria-hidden="true" />}
          {kind.type === "ColorSample" && (
            <span
              className="rc-swatch"
              style={{ background: `rgb(${kind.rgb[0]} ${kind.rgb[1]} ${kind.rgb[2]})` }}
              aria-hidden="true"
            />
          )}
          <span className="rc-when-label">When {triggerLabel(rule.trigger)}</span>
        </span>
        <span className="rc-then">{ruleSummary(rule)}</span>
        {failedReason && <span className="rc-failed">{failedReason}</span>}
      </button>
      <div className="rc-controls">
        <Switch
          checked={rule.enabled}
          onCheckedChange={() => onToggle(rule.id)}
          aria-label={`Rule enabled`}
        />
        <button type="button" className="rc-icon" aria-label="Move up" disabled={index === 0} onClick={() => onMove(rule.id, -1)}>
          <ChevronUp aria-hidden="true" />
        </button>
        <button type="button" className="rc-icon" aria-label="Move down" disabled={index === count - 1} onClick={() => onMove(rule.id, 1)}>
          <ChevronDown aria-hidden="true" />
        </button>
        <button type="button" className="rc-icon rc-delete" aria-label="Delete rule" onClick={() => onDelete(rule.id)}>
          <Trash2 aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
```

There is no `switch.tsx` in `src/components/ui/` (verified) — install it first: `pnpm dlx shadcn@latest add switch` (never hand-copy; per CLAUDE.md). Run `pnpm lint:fix` after installing so the generated file matches biome. `RuleDeck.tsx` maps rules → `RuleCard` (live = `liveRuleId === rule.id`, failedReason = `failed?.ruleId === rule.id ? failed.reason : null`, watching = `running && rule.enabled && liveRuleId !== rule.id`), renders `draft` first, and an always-present "+ Add rule" button (`aria-label="Add rule"`) at the top. NO copy when `rules` is empty. CSS: `.rd-root` column flex/gap/scroll; `.rc-root` card with `data-live` accent ring, `data-failed` red border, `data-watching` subtle pulse animation, `data-disabled` opacity.

- [ ] **Step 4: Run to verify pass** — `pnpm vitest run src/components/studio/macros/RuleDeck.test.tsx` → PASS. `pnpm tsc --noEmit` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/components/studio/macros/RuleCard.tsx src/components/studio/macros/RuleDeck.tsx src/components/studio/macros/RuleDeck.test.tsx src/components/studio/macros/macro-editor.css
git commit -m "feat(macros): rule deck and rule card components"
```

---

### Task 4: TriggerPicker component (additive, unwired)

**Files:**
- Create: `src/components/studio/macros/TriggerPicker.tsx`
- Modify: `src/components/studio/macros/macro-editor.css` (append `.tp-*` styles)
- Test: `src/components/studio/macros/TriggerPicker.test.tsx`

**Interfaces:**
- Consumes: `TextSpan` from `@/types`.
- Produces:

```tsx
export interface TriggerPickerProps {
  /** null = OCR in flight (show scanning state, no boxes yet). */
  spans: TextSpan[] | null;
  onPickSpan: (span: TextSpan) => void;
  onCancel: () => void;
}
```

Rendered by the dock INSIDE a wrapper already sized to the video content rect, so span boxes position with plain percentages. The root layer must NOT block the player's own drag-to-select (image/color path): root has `pointer-events: none`; span boxes and the cancel chip re-enable `pointer-events: auto`.

- [ ] **Step 1: Write the failing tests**

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TriggerPicker } from "@/components/studio/macros/TriggerPicker";
import type { TextSpan } from "@/types";

const spans: TextSpan[] = [
  { text: "climb the stairs", region: { x: 0.4, y: 0.2, w: 0.2, h: 0.05 }, confidence: 0.9 },
  { text: "SCORE 120", region: { x: 0.05, y: 0.05, w: 0.15, h: 0.04 }, confidence: 0.8 },
];

describe("TriggerPicker", () => {
  it("shows a scanning state while spans are null", () => {
    render(<TriggerPicker spans={null} onPickSpan={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText(/scanning/i)).toBeInTheDocument();
  });

  it("renders a positioned, clickable box per span", () => {
    const onPickSpan = vi.fn();
    render(<TriggerPicker spans={spans} onPickSpan={onPickSpan} onCancel={vi.fn()} />);
    const box = screen.getByRole("button", { name: /climb the stairs/i });
    expect(box.style.left).toBe("40%");
    expect(box.style.top).toBe("20%");
    expect(box.style.width).toBe("20%");
    expect(box.style.height).toBe("5%");
    fireEvent.click(box);
    expect(onPickSpan).toHaveBeenCalledWith(spans[0]);
  });

  it("offers drag-a-box guidance when OCR found nothing", () => {
    render(<TriggerPicker spans={[]} onPickSpan={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText(/drag a box/i)).toBeInTheDocument();
  });

  it("cancel chip fires onCancel", () => {
    const onCancel = vi.fn();
    render(<TriggerPicker spans={spans} onPickSpan={vi.fn()} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run src/components/studio/macros/TriggerPicker.test.tsx` → FAIL.

- [ ] **Step 3: Implement**

```tsx
import type { TextSpan } from "@/types";

export interface TriggerPickerProps {
  spans: TextSpan[] | null;
  onPickSpan: (span: TextSpan) => void;
  onCancel: () => void;
}

/**
 * Overlay for the paused authoring frame: clickable boxes over OCR-detected
 * text spans. The root is pointer-transparent so the player's drag-to-select
 * (image/color trigger authoring) still works underneath; only the boxes and
 * the hint/cancel chip catch the pointer.
 */
export function TriggerPicker({ spans, onPickSpan, onCancel }: TriggerPickerProps) {
  return (
    <div className="tp-root" data-scanning={spans === null || undefined}>
      {spans?.map((span, i) => (
        <button
          key={`${span.text}-${i}`}
          type="button"
          className="tp-span"
          style={{
            left: `${span.region.x * 100}%`,
            top: `${span.region.y * 100}%`,
            width: `${span.region.w * 100}%`,
            height: `${span.region.h * 100}%`,
          }}
          title={span.text}
          aria-label={`Use text "${span.text}" as the trigger`}
          onClick={() => onPickSpan(span)}
        />
      ))}
      <div className="tp-chip">
        {spans === null ? (
          <span>Scanning frame for text…</span>
        ) : spans.length === 0 ? (
          <span>No text found — drag a box on the frame for an image or color trigger</span>
        ) : (
          <span>Click text to use it as the trigger, or drag a box</span>
        )}
        <button type="button" className="tp-cancel" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
```

CSS: `.tp-root { position: absolute; inset: 0; pointer-events: none; z-index: 30; }`, `.tp-span { position: absolute; pointer-events: auto; border: 1.5px solid var(--macro-accent); border-radius: 4px; background: color-mix(in oklch, var(--macro-accent) 12%, transparent); cursor: pointer; }` with hover emphasis, `.tp-chip { position: absolute; bottom: 12px; left: 50%; transform: translateX(-50%); pointer-events: auto; }` styled like the existing `.anp-chip`.

- [ ] **Step 4: Run to verify pass** — `pnpm vitest run src/components/studio/macros/TriggerPicker.test.tsx` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/studio/macros/TriggerPicker.tsx src/components/studio/macros/TriggerPicker.test.tsx src/components/studio/macros/macro-editor.css
git commit -m "feat(macros): trigger picker overlay with clickable OCR spans"
```

---

### Task 5: Switchover — wire the editor, rename events, delete the canvas

The atomic flip. Everything lands in one commit so the tree never holds a half-migrated editor.

**Files:**
- Modify: `src/types.ts` — `MacroDoc` becomes `{ id, name, rules: MacroRule[], poll_interval_ms: number, created_at: number }`; DELETE `MacroNode`, `MacroNodeKind`, `MacroEdge`.
- Modify: `src/hooks/useMacros.ts` — event renames + payload shapes.
- Modify: `src/hooks/__tests__/useMacros.test.ts` — update mocked event names (`macro-rule-fired`/`macro-rule-settled`) and payloads (`ruleId`), `liveRuleId`/`failed.ruleId` assertions; add a case: `macro-rule-settled` clears `liveRuleId` while `runState` stays `"running"`.
- Modify: `src/components/studio/macros/MacroEditor.tsx` — full rewrite (below).
- Modify: `src/components/studio/macros/AuthoringDock.tsx` — recording selector, Add rule, picker slot, anchor ticks, draft-aware keys.
- Modify: `src/components/studio/macros/MacroToolbar.tsx` — no change to props; callers compute `valid` via `isRunnableRulesDoc`.
- Modify: `src/components/studio/StudioEditor.tsx` — only if it references `liveNodeId`/`failed` field names directly (grep; it spreads `useMacros` results into MacroEditor props).
- Delete: `MacroCanvas.tsx`, `SegmentNodeView.tsx`, `WaitNodeView.tsx`, `AddNodePanel.tsx`, `AddNodePanel.test.tsx`, `src/lib/macro-flow.ts`, `src/lib/macro-flow.test.ts`, `src/lib/macro-chain.ts`, `src/lib/macro-chain.test.ts`, `src/lib/macro-wait.ts`, `src/lib/macro-wait.test.ts` (if present).
- Modify: `src/components/studio/macros/macro-editor.css` — remove `.macro-canvas-*` and `.anp-*` blocks (keep `.anp-chip` styles only if the dock still uses the chip class; otherwise rename to a dock-owned class).
- Modify: `package.json` — `pnpm remove @xyflow/react`.
- Tests: rewrite `MacroEditor.test.tsx`, update `AuthoringDock.test.tsx`, update `MacroToolbar.test.tsx` only if it imported node helpers.

**Interfaces:**
- Consumes: everything produced by Tasks 1–4 (exact names above).
- Produces: `useMacros` returns `{ macros, load, save, remove, run, stop, runState, liveRuleId, failed, clearFailed }` where `failed: { ruleId: string; reason: string } | null`; listens to `"macro-rule-fired"` (`{ macroId, ruleId, index }` → set `liveRuleId`), `"macro-rule-settled"` (→ `liveRuleId = null`), `"macro-run-finished"`, `"macro-run-failed"` (`{ macroId, ruleId, reason }`).

- [ ] **Step 1: Flip `types.ts` and `useMacros.ts`**

`useMacros.ts` changes, mirroring the current listener structure exactly:

```ts
export interface MacroRunFailure {
  ruleId: string;
  reason: string;
}

interface RuleEventPayload {
  macroId: string;
  ruleId: string;
  index: number;
}

interface MacroRunFailedPayload {
  macroId: string;
  ruleId: string;
  reason: string;
}

// state: liveRuleId replaces liveNodeId
const unlistenFired = listen<RuleEventPayload>("macro-rule-fired", (event) => {
  setLiveRuleId(event.payload.ruleId);
  setRunState("running");
  setFailed(null);
});
const unlistenSettled = listen<RuleEventPayload>("macro-rule-settled", () => {
  // Back to watching between fires.
  setLiveRuleId(null);
});
// run-finished / run-failed listeners as before, with ruleId in the failure.
```

- [ ] **Step 2: Rewrite `MacroEditor.tsx`**

Keep from the old file verbatim: `emptyMacro` (now `{ id, name, rules: [], poll_interval_ms: 250, created_at: Date.now() }`), the saved-list handoff effect, `handleSelect`/`handleCreate`/`handleDeleteClick`, `handleSave`, run gating (`needsSave`, `runDisabledReason`, `isStoppedRun` — reason `"stopped"` unchanged), `captureImageWait`, `sampleColor`. Replace canvas/panel state with:

```tsx
// Draft-rule authoring state. Entered via Add rule (OCR span path) or a
// drag-authored image/color target; exits on Add or Cancel.
interface RuleDraft {
  anchorMs: number;
  trigger: PerceptionTarget | null; // null → picker is up
  spans: TextSpan[] | null;         // null → OCR in flight
  actionType: "PlayInputs" | "Stop";
}
const [draft, setDraft] = useState<RuleDraft | null>(null);
const [selectedRuleId, setSelectedRuleId] = useState<string | null>(null);
// One-shot seek request consumed by the dock (rule-card click).
const [pendingSeekMs, setPendingSeekMs] = useState<number | null>(null);
// Inline capture-failure message on the draft card (no toast system exists;
// this also fixes the standing "capture failure invisible" backlog item).
const [draftError, setDraftError] = useState<string | null>(null);
```

`handleDockSaveTarget` wraps its await in try/catch: on failure `setDraftError("Couldn't capture that — try again")` and log (the existing `captureImageWait` already logs); on success clear it. The draft card renders `draftError` when set.

Key handlers (all in MacroEditor, passed down):

```tsx
// Add rule pressed in the dock (or deck) at the current playhead.
const handleStartDraft = useCallback(
  async (timestampMs: number) => {
    if (!authoringRecording) return;
    const anchorMs = Math.round(timestampMs);
    setDraft({ anchorMs, trigger: null, spans: null, actionType: "PlayInputs" });
    try {
      const res = await invoke<ObservationResult>("extract_region", {
        source: { type: "Recording", recording_id: authoringRecording.id, timestamp_ms: anchorMs },
        region: { x: 0, y: 0, w: 1, h: 1 },
        kind: { type: "TextOcr", expect: null },
      });
      setDraft((d) => (d ? { ...d, spans: res.type === "Text" ? res.spans : [] } : d));
    } catch (e) {
      logEvent("error", "macros", "frame_ocr_failed", { error: e });
      setDraft((d) => (d ? { ...d, spans: [] } : d)); // degrade to drag-a-box
    }
  },
  [authoringRecording],
);

const applyDraftTrigger = useCallback(
  (trigger: PerceptionTarget, anchorMs: number) => {
    setDraft((d) => ({
      anchorMs,
      trigger,
      spans: null,
      actionType: d?.actionType ?? "PlayInputs",
    }));
    if (authoringRecording?.video) {
      setAuthoringRange(
        defaultActionRange(workingDoc, authoringRecording.id, anchorMs, authoringRecording.video.duration_ms),
      );
    }
  },
  [authoringRecording, workingDoc],
);

const handlePickSpan = useCallback(
  (span: TextSpan) => {
    if (!draft) return;
    applyDraftTrigger(spanTrigger(span), draft.anchorMs);
  },
  [draft, applyDraftTrigger],
);

// Drag-authored image/color target — works both mid-draft and as a direct
// entry point (drag on the frame with no draft open starts one).
const handleDockSaveTarget = useCallback(
  async (target: PerceptionTarget, timestampMs: number) => {
    if (!authoringRecording) return;
    const resolved =
      target.kind.type === "TemplateMatch"
        ? await captureImageWait(authoringRecording.id, target, timestampMs)
        : target;
    applyDraftTrigger(resolved, Math.round(timestampMs));
  },
  [authoringRecording, captureImageWait, applyDraftTrigger],
);

const handleConfirmDraft = useCallback(() => {
  if (!draft?.trigger || !authoringRecording) return;
  let rule: MacroRule;
  if (draft.actionType === "Stop") {
    rule = stopRule(draft.trigger, authoringRecording.id, draft.anchorMs);
  } else {
    if (!authoringRange || authoringRange.b <= authoringRange.a) return;
    rule = playInputsRule(draft.trigger, authoringRecording, draft.anchorMs, authoringRange.a, authoringRange.b);
  }
  setWorkingDoc((doc) => ({ ...doc, rules: [...doc.rules, rule] }));
  setDirty(true);
  setDraft(null);
  setAuthoringRange(null);
}, [draft, authoringRecording, authoringRange]);

const handleCancelDraft = useCallback(() => {
  setDraft(null);
  setAuthoringRange(null);
}, []);

// Deck card handlers: reorder/toggle/delete via macro-rules utils + setDirty.
const handleSelectRule = useCallback(
  (ruleId: string) => {
    setSelectedRuleId(ruleId);
    const rule = workingDoc.rules.find((r) => r.id === ruleId);
    if (!rule?.anchor) return;
    if (rule.anchor.recording_id !== authoringRecordingId) {
      setAuthoringRecordingId(rule.anchor.recording_id);
    }
    setPendingSeekMs(rule.anchor.timestamp_ms); // dock prop, see Step 3
    const prov = rule.action.type === "PlayInputs" ? rule.action.provenance : null;
    setAuthoringRange(prov ? { a: prov.start_ms, b: prov.end_ms } : null);
  },
  [workingDoc, authoringRecordingId],
);
```

Draft card (rendered into `RuleDeck`'s `draft` slot) — trigger pending: label "Pick the trigger on the frame" + Cancel; trigger set: `triggerLabel(draft.trigger)`, the shared-range chip (`fmtMmSs(range.a)–fmtMmSs(range.b) · N events` — reuse `eventsInRange`), a two-button action toggle (`Play inputs` / `Stop macro` setting `draft.actionType`), and Add rule (disabled unless Stop or valid range) / Cancel buttons. This is plain JSX inside MacroEditor (a `DraftCard` local component in the same file is fine).

Layout: keep `ResizablePanelGroup`; sidebar hosts `<RuleDeck …>`; main panel hosts `<AuthoringDock …>` when `authoringRecording` is set, else an empty stage div (`.macro-editor-canvas-pane` retained as a plain background — NO copy inside). `valid` for the toolbar = `isRunnableRulesDoc(workingDoc)`.

- [ ] **Step 3: Adapt `AuthoringDock.tsx`**

Changes only — In/Out marking, Enter/Escape handler structure, controlsHost, loop preview all stay:

1. New props replacing `canvasOverlay`/`onAddSegment`/`onSaveTarget` bundle:

```tsx
export interface AuthoringDockProps {
  recording: Recording;
  recordings: Recording[];                 // selector options (video-bearing, filtered by caller)
  onSelectRecording: (id: string) => void; // selector change
  range: LoopRegion | null;
  onRangeChange: (range: LoopRegion | null) => void;
  /** Rule-anchor markers for the timeline's tick lane. */
  anchorTicks: Array<{ ms: number; label: string }>;
  /** Seek request from outside (rule card click), consumed once. */
  pendingSeekMs: number | null;
  onSeekConsumed: () => void;
  /** Start a rule draft at the playhead (Add rule button / R key). */
  onAddRule: (timestampMs: number) => void;
  /** True while the trigger picker should be shown; the dock pauses. */
  picking: boolean;
  /** Picker overlay + draft-mode chrome, rendered over the video content rect. */
  pickerOverlay?: ReactNode;
  onSaveTarget: (target: PerceptionTarget, timestampMs: number) => Promise<void>;
  onSampleColor: (region: Region, timestampMs: number) => Promise<[number, number, number]>;
  /** Escape pressed with a draft open. */
  onCancelDraft: () => void;
  hasDraft: boolean;
}
```

2. Recording selector: the same shadcn `Select` markup the old AddNodePanel used (`aria-label="Recording"`), placed in the clip row before the In/Out buttons.
3. "+ Add rule" button in the clip row: `onClick={() => onAddRule(Math.round(videoS * 1000))}`; key handler gains `else if (e.key === "r" || e.key === "R") { onAddRule(Math.round(videoS * 1000)); }`.
4. Key handler Escape branch: if `hasDraft` → `e.preventDefault(); onCancelDraft();` takes precedence over range-clear. Enter branch: keep range-Enter but only when NO draft is open (the draft's Add button owns confirm; keyboard Enter on a focused button already works).
5. Picker overlay placement: wrap the player in the existing `.adock-player` div with `position: relative`; when `pickerOverlay` is set, render a sibling absolutely positioned to the **video content rect** — compute with `videoDisplayRect` from `@/lib/video-rect` using the player container's `getBoundingClientRect()` and `recording.video.width/height` (ResizeObserver on the container, same pattern StudioPlayer uses internally — check `StudioPlayer` for its content-rect state and reuse its approach; if StudioPlayer exposes none, measure in the dock).
6. `pendingSeekMs`: effect — when non-null, `playerRef.current?.seek(pendingSeekMs / 1000); onSeekConsumed();`.
7. When `picking`, pause playback (`playerRef.current` — check `StudioPlayerHandle` for a pause method; if it only has `seek`, seeking to the current time pauses via the drag-arm path — if not, add `pause()` to `StudioPlayerHandle`, a 3-line addition).
8. Timeline: pass `perceptionTicks={anchorTicks}`.
9. Remove the `interactionMode` fieldset and `canvasOverlay` rendering (mode switch dies with the canvas — stage gestures always belong to the player now).
10. The old "+ Add Segment" button and its Enter binding become the draft flow; delete them.

- [ ] **Step 4: Delete the canvas stack + dep**

```bash
git rm src/components/studio/macros/MacroCanvas.tsx src/components/studio/macros/SegmentNodeView.tsx src/components/studio/macros/WaitNodeView.tsx src/components/studio/macros/AddNodePanel.tsx src/components/studio/macros/AddNodePanel.test.tsx src/lib/macro-flow.ts src/lib/macro-flow.test.ts src/lib/macro-chain.ts src/lib/macro-chain.test.ts src/lib/macro-wait.ts
pnpm remove @xyflow/react
```

(`git rm` also `src/lib/macro-wait.test.ts` if it exists.) Purge `.macro-canvas-*`, `.anp-*` CSS blocks (move the chip styles the dock reuses to `.adock-chip` proper). Grep for stragglers: `grep -rn "xyflow\|MacroNode\|MacroEdge\|macro-flow\|macro-chain\|macro-wait\|AddNodePanel\|MacroCanvas\|liveNodeId\|nodeSummary" src/ src-tauri/ --include="*.ts" --include="*.tsx" --include="*.rs"` → expect zero hits outside this plan/spec docs.

- [ ] **Step 5: Rewrite `MacroEditor.test.tsx` + update `AuthoringDock.test.tsx`**

MacroEditor integration tests (mock `@/lib/observability`'s `invoke` and `@tauri-apps/api/event`'s `listen` as the current suite does; mock `StudioPlayer` if the existing dock tests do). Cover:

1. Renders the deck with a card per rule of the selected macro (seed `useMacros`-shaped props directly — the component takes them as props).
2. Empty macro → no empty-state copy anywhere (`container.textContent` contains no "No rules"/"no nodes" strings), Add rule button present.
3. Add-rule flow: click Add rule → `invoke` called with `extract_region` and full-frame region → picker shows spans (mock resolves `{ type: "Text", spans: [span] }`) → click span → draft card shows `"climb the stairs"` and the pre-selected range → click "Add rule" confirm → new card appears, toolbar Save enabled (dirty).
4. OCR failure path: `extract_region` rejects → picker shows the drag-a-box hint (spans `[]`), no crash, error logged.
5. Stop-action draft: toggle "Stop macro" in the draft card → confirm → card renders "Stop macro"; range not required.
6. Reorder/toggle/delete from the deck mutate the working doc and mark dirty.
7. Card click on a rule with an anchor on another recording switches the dock recording (assert `Select` value change) — mock recordings list with two entries.
8. Run gating unchanged: unsaved → Run disabled with "Save before running."; failed run with reason "stopped" → NO card flagged; failed with real reason → card flagged red.
9. `liveRuleId` prop → live card highlighted.

AuthoringDock tests: update for new props (selector present and labeled "Recording"; Add rule button calls back with rounded playhead ms; R key triggers; Escape with `hasDraft` cancels the draft instead of clearing the range; anchor ticks passed through to the timeline; pendingSeek consumed).

- [ ] **Step 6: Full frontend gates**

Run: `pnpm typecheck` → clean. `pnpm vitest run` → all pass. `pnpm lint` → clean.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(macros): rule-deck authoring replaces node canvas

Reactive when/then rules: scrub to a frame, click an OCR'd text span (or
drag a box for image/color), attach the input range. Removes the react-flow
canvas, AddNodePanel, Segment/WaitFor forms, and @xyflow/react."
```

---

### Task 6: Whole-feature gates and residue sweep

**Files:**
- Verify-only unless issues surface: full repo.

- [ ] **Step 1: Backend + frontend full builds**

Run in `src-tauri/`: `cargo test` and `cargo clippy -- -D warnings` (matches CI). Run at root: `pnpm build` (tsc + vite). Expected: all green.

- [ ] **Step 2: Residue grep**

`grep -rn "Segment\|WaitFor\|node" src/components/studio/macros/ src/lib/macro-*.ts` — remaining hits must be legitimate (e.g. `macro-segment.ts`'s event-carving helpers, which the rule builders still use). `grep -rn "no nodes\|No nodes" src/` → zero hits.

- [ ] **Step 3: Fix anything found, re-run gates, commit**

```bash
git add -A && git commit -m "chore(macros): reactive-rules residue sweep"
```

(Skip the commit if the sweep found nothing.)

---

## Out of scope (per spec non-goals)

Scan-recording trigger validation; one-shot/ordered rule hybrids; migration of old macro docs; per-rule poll intervals or UI for `poll_interval_ms`; drag-based card reordering (buttons suffice v1 — native DnD is a polish follow-up); video-frame thumbnails on text/color rule cards.
