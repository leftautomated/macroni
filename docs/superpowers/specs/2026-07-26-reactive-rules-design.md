# Reactive Rules — macro model & authoring redesign

**Date:** 2026-07-26
**Status:** Approved (user directed autonomous continuation 2026-07-26)
**Supersedes (as user-facing model):** macro-graph-runtime, macro-canvas, macro-snip, macro-visual-wait, macro-authoring-dock specs. The perception layer (targets, extractors, `save_target`, `extract_region`) and the playback engine are reused unchanged.

## Problem

The current macro model exposes three concepts — `Segment` node, `WaitFor` node, and a hand-drawn edge — where the user thinks in one: "when the screen shows *X*, play *these inputs*." Authoring is split across two abstract sidebar forms ("Add Segment", "Add Text Wait") plus a react-flow canvas, none of which start from the thing the user actually has: a recording with frames that show the moments that matter.

Driving use case: a game recording contains prompts ("start", "climb the stairs", "board the train"). The user wants to scrub to the frame showing each prompt and attach the inputs that should play when that prompt appears live — in any order, repeatedly, as the game presents them.

## Research basis (2026-07-26 survey)

Surveyed: Keyboard Maestro, MacroDroid, IFTTT, SikuliX/Sikuli (UIST '09), AirTest, BlueStacks/LDPlayer macro recorders, Pulover's Macro Creator, TinyTask, UiPath StudioX, Power Automate Desktop, Zapier vs n8n, CVAT, TAStudio, Loom, CoScripter, Rousillon, Scratch, Unreal Blueprints. Principles applied:

1. **Capture, don't describe** — Sikuli's study showed capturing a visual target beats typing a description; typing becomes an edit path only.
2. **Trigger + actions are one composite object** (IFTTT applet, MacroDroid card, Scratch hat block).
3. **Lists beat node canvases for this persona** (StudioX removed the graph tier; Zapier-vs-n8n; Blueprint spaghetti).
4. **The frame is the anchor** (CVAT keyframes, TAStudio frame-aligned input editing).
5. **Validate against the recording** — macroni can scan the recording for trigger matches before any live run (deferred, see Non-goals).

## Decisions (user-confirmed)

- **Run model: reactive rules.** A macro is a set of when/then rules; the runner watches the screen and fires whichever rule matches. Not a linear chain.
- **Replace entirely.** Segment/WaitFor/edges/canvas are removed as user-facing concepts. Fix-forward: **no migration** of previously saved macros — docs that no longer deserialize against the new shape are skipped at load (logged, not crashed).
- **Termination: manual Stop plus an optional Stop rule** ("when screen shows X → stop the macro"). No per-rule timeouts, no max duration.
- **No empty-state copy.** An empty rule deck renders nothing but the always-present Add affordance (explicit user request; applies in place of the old "No nodes on this macro" text, which is deleted with the canvas).

## Document model

```ts
interface MacroDoc {
  id: string
  name: string
  rules: MacroRule[]        // ordered; index = priority (top wins)
  poll_interval_ms: number  // default 250
  created_at: number
}

interface MacroRule {
  id: string
  trigger: PerceptionTarget            // existing type, unchanged (TextOcr | TemplateMatch | ColorSample, region-scoped)
  action: RuleAction
  enabled: boolean
  anchor?: { recording_id: string; timestamp_ms: number } | null  // frame the rule was authored on
}

type RuleAction =
  | { type: "PlayInputs"; events: InputEvent[]; speed: number; provenance?: MacroProvenance | null }
  | { type: "Stop" }
```

Removed: `MacroNode`, `MacroNodeKind` (`Segment`, `WaitFor`), `MacroEdge`, node `x`/`y`, `timeout_ms`, `poll_interval_ms` per-wait (now doc-level; default 250, not exposed in the UI in v1). `PerceptionTarget`, `TargetKind`, `Observation*`, `MacroProvenance`, and `Recording` are unchanged. Rust mirrors the same shape (serde); stored docs that fail to deserialize are skipped with a warning.

A TextOcr trigger authored from a span is **region-scoped** to that span's box (padded), which makes matching more precise than today's full-frame text waits. The card exposes the region and expect-text for editing.

## Runtime semantics (`run_rules` replaces `run_chain`)

Port-driven like today (`Simulator`, `WaitProbe`, `MacroClock`, `MacroEmitter`), worker thread, engine slot claim/release unchanged.

Per poll tick (every `poll_interval_ms`, cancellable sleep):

1. Capture/evaluate the enabled, **armed** rules top-to-bottom against the current screen; the first match fires. (Probe API may gain a capture-once-evaluate-many form; per-rule sequential evaluation is an acceptable v1 if the capture cost forces it.)
2. Firing a `PlayInputs` rule compiles and plays its events through the existing playback plan; watching is paused while inputs play (single-threaded, as today).
3. **Edge-triggered re-arm:** a fired rule is disarmed until a subsequent tick observes its trigger NOT matching; only then is it armed again. This prevents a persistent on-screen prompt from re-firing in a loop.
4. A `Stop` rule firing ends the run: `run_finished(ok=true)`. Manual stop: cancel flag, `run_failed(reason="stopped")` mapping preserved so the UI keeps treating deliberate stops as neutral.
5. Probe/compile errors: `run_failed(macro_id, rule_id, reason)`; the UI flags that rule's card.

Emitter renames: `node_started/node_finished` → `rule_fired/rule_settled` (same payload shape, `rule_id` instead of `node_id` + index). `run_finished`/`run_failed` unchanged.

Validation (`validate_runnable`): at least one enabled rule; every `PlayInputs` rule has ≥1 event. Linear-chain validation (`chain_order`, `isLinearChain`) is deleted.

## Authoring UX

Layout keeps: header (MacrosMenu, macro name, MacroToolbar Save/Run/Stop with the same save-before-run gating), AuthoringDock (StudioPlayer + StudioTimeline + In/Out marking + transport). Deleted: react-flow canvas and overlay mode, Canvas/Frame mode switch, AddNodePanel and both its forms.

The recording selector (previously in AddNodePanel) moves into the dock's control row, defaulting to the most recently created recording with video when none is chosen yet.

**Rule deck** (sidebar, replaces AddNodePanel): one card per rule, sentence-shaped:

> [trigger badge] **When** "climb the stairs" → **Play** 17 events · 8.2s

- The trigger badge needs no new machinery: TextOcr shows a kind icon + the expect text, TemplateMatch shows its already-captured template image, ColorSample shows a color swatch. (A video-frame thumbnail for text/color triggers is a possible later polish, not v1.)
- Enable/disable toggle, delete, drag-to-reorder (order = priority).
- Click card → seek player to `anchor.timestamp_ms` (switching the dock recording if the anchor names another one) and highlight the rule's provenance range on the timeline.
- Run state: firing card highlighted; failed card red; enabled cards show a subtle watching state while a run is live (arm/disarm is runtime-internal and not surfaced per-card).
- Stop rules render as "**When** … → **Stop macro**".
- Empty deck: no copy, only the Add affordance.

**Create flow — scrub → show → attach:**

1. Scrub to the frame; press **Add rule** (dock button or `R`, same key-exemption rules as the existing I/O handler).
2. Trigger picker on the paused frame: full-frame OCR via existing `extract_region` (TextOcr) renders clickable boxes over detected spans. Click a span → TextOcr trigger, `expect` prefilled from the span text, region scoped to the span box. Alternatively drag a box → choose Image (existing `save_target` crop flow) or Color (existing sample flow). No spans → overlay prompts to drag a box. Typing text is available only as a later edit on the card.
3. Action step: default **Play inputs**, pre-ranged from the anchor frame to the next rule's anchor on this recording (or recording end), adjustable with the existing timeline drag/In/Out; or **Stop macro** (skips the range). Confirm → card appears at the bottom of the deck.

Timeline shows a marker at each rule anchor for the selected recording.

## Component & file plan

Delete: `MacroCanvas.tsx`, `SegmentNodeView.tsx`, `WaitNodeView.tsx`, `AddNodePanel.tsx` (+tests), `macro-flow.ts`, `macro-chain.ts` (+tests), `@xyflow/react` dependency, canvas CSS, Rust `chain_order`/linear validation.

Adapt: `MacroEditor.tsx` (owns rule-draft state machine instead of canvas/panel state), `AuthoringDock.tsx` (recording selector, Add-rule button, trigger-picker overlay host, anchor markers; In/Out & range machinery unchanged), `useMacros.ts` + `StudioEditor.tsx` (event payloads: `liveNodeId` → `liveRuleId`, failed node → failed rule; the lifted-hook pattern stays), `macro-wait.ts` → rule builders (`ruleFromTrigger`, `stopRule`), `macro-segment.ts` reused as-is for event carving, `macro-editor.css` (canvas styles out, deck/picker styles in), Rust `runner.rs` → `run_rules`, `macros/mod.rs` types, `commands.rs` (validation + emitter event names), `store.rs` (skip-on-deserialize-failure).

New: `RuleDeck.tsx`, `RuleCard.tsx`, `TriggerPicker.tsx` (OCR-span overlay + drag box), `macro-rules.ts` (doc utilities: reorder, arm/disarm bookkeeping helpers for UI state).

## Error handling

- Image-crop / color-sample failure during authoring: the draft stays open and shows an inline error line on the draft card ("Couldn't capture that — try again"), plus a log (resolves the standing "capture failure invisible to user" backlog item; the repo has no toast system and this doesn't justify adding one).
- OCR of the paused frame returns nothing: degrade to drag-a-box mode within the picker (inline hint, not a blocking error).
- Run-time probe error: `run_failed` with the rule id; card flagged; run ends (same policy as today's wait probe).
- Old-schema macro docs at load: skipped with a logged warning; never crash the store.

## Testing

- **Rust (`run_rules` over fake ports):** priority order (top rule wins on simultaneous match), edge-triggered re-arm (persistent trigger fires once until it clears), disabled rules skipped, Stop rule → `run_finished`, manual cancel mid-sleep and mid-playback, probe error → `run_failed(rule_id)`, empty/invalid doc validation.
- **Frontend:** rule builders and doc utilities; RuleDeck reorder/toggle/delete/seek-on-click; TriggerPicker span-click → correctly scoped TextOcr draft; MacroEditor integration: scrub → add rule → span click → range confirm → card rendered, over mocked `invoke`; Run/Stop state mapping including neutral "stopped".
- Deleted components' tests removed; suite must stay green (`pnpm vitest run`, `cargo test`).

## Non-goals (deferred)

- **Scan-recording validation** — evaluate a trigger across the recording and paint matches on the timeline (top fast-follow candidate).
- Reactive+sequenced hybrids (one-shot rules, "only after rule X" ordering).
- Multi-monitor / capture-region selection changes; anything in the perception extractors themselves.
- Migration/import of pre-rules macro docs.
