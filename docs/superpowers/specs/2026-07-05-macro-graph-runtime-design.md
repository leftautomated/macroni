# Macro Graph — Program Direction & Sub-Project A (Model + Runtime) Design

**Vision:** Macros become the durable, executable artifact of the app — built
on a canvas as a node graph: event segments snipped from recordings, wired
together with perception-driven decisions. Recordings become raw capture
material. This supersedes the paused annotation-overlay UX
(`PERCEPTION_STUDIO_UI`) as the way perception gets used.

**Program decomposition (one spec → plan → build cycle each, in order):**

- **A. Macro model + linear runtime (THIS SPEC)** — headless: schema, store,
  executor, Tauri commands. No UI beyond a temporary run affordance.
- **B. Canvas editor** — `@xyflow/react` node-graph view as a third Studio
  view ("Macros"); create/arrange/connect/run; nodes light up live during
  runs. (Separate spec.)
- **C. Snip & condition authoring** — Studio-timeline range → segment node;
  perception-target picker → wait nodes (revives the paused perception
  components inside the canvas context). (Separate spec.)

**Cross-cutting decisions (locked now):**

- **Copy-with-provenance snipping.** Nodes embed their own data (events;
  target incl. assets). Provenance (`recording_id`, time range) is metadata —
  enables a later "re-pull from source" action. Macros never break when
  recordings are deleted.
- **V1 execution is a linear chain** (segments + wait-conditions). Branching
  is out of scope for A/B/C but the schema stores edges, so branching later
  is a validator + runtime change, not a schema migration.
- Canvas library `@xyflow/react`; canvas lives in the Studio window.

---

## Sub-Project A — Global Constraints

- **Never destabilize recording or playback.** The runner reuses the existing
  `PlaybackPlan` + simulator seam and the engine's stop plumbing; no changes
  to capture.
- **Self-contained macros:** `macros/{id}.json` + `macros/{id}/assets/` own
  every byte needed to run (template PNGs copied in at authoring time).
  Deleting a macro removes both; the orphan sweep covers them.
- **Backward compatible:** no changes to `Recording` serialization. New
  types are additive.
- **Linear-chain validation:** a `MacroDoc` whose edges do not form a single
  path visiting each node exactly once is rejected at load AND before run
  with a typed error — never partially executed.
- **Wait accuracy:** a `WaitFor` matches using the SAME extractor semantics
  as the Studio "Test live" path (accurate-mode OCR for text, ratio-scaled
  template match, per-channel color tolerance). On timeout: abort the run,
  emit which node failed and why. No silent continues.
- **macOS-first:** WaitFor evaluation needs the live grab (macOS); segment
  replay is cross-platform. On non-macOS, running a macro containing WaitFor
  nodes fails at validation with a clear error.
- Deferred (NOT in A): branching/loops, canvas UI, snipping UI, re-pull
  action (schema supports it), parallel paths, run history.

## Data Model (`src-tauri/src/macros/mod.rs`, TS mirrors in `src/types.ts`)

```rust
pub struct MacroDoc {
    pub id: String,
    pub name: String,
    pub nodes: Vec<MacroNode>,
    pub edges: Vec<MacroEdge>,   // (from_node_id, to_node_id)
    pub created_at: i64,
}

pub struct MacroEdge { pub from: String, pub to: String }

pub struct MacroNode {
    pub id: String,
    pub kind: MacroNodeKind,
    /// Canvas position, persisted for sub-project B; unused by the runtime.
    pub x: f32,
    pub y: f32,
}

#[serde(tag = "type", rename_all = "PascalCase")]  // house tagging
pub enum MacroNodeKind {
    Segment {
        events: Vec<InputEvent>,          // embedded copy
        speed: f64,                       // default 1.0
        provenance: Option<Provenance>,
    },
    /// `target` is an embedded copy (perception::Target). For TemplateMatch
    /// targets, save_macro copies the template image to
    /// macros/{macro_id}/assets/{target_id}.png and rewrites
    /// target.kind.image to that macro-relative path (self-containment).
    WaitFor {
        target: Target,
        timeout_ms: u64,                  // default 10_000
        poll_interval_ms: u64,            // default 500, min 100
    },
}

pub struct Provenance {
    pub recording_id: String,
    pub start_ms: i64,
    pub end_ms: i64,
}
```

Chain validation (`pub fn chain_order(doc: &MacroDoc) -> Result<Vec<&MacroNode>, MacroError>`):
exactly one node with no incoming edge (start), one with no outgoing (end),
every node visited once following edges; duplicate/self/unknown-id edges are
errors. Pure, fully tested.

## Store (`src-tauri/src/macros/store.rs`)

Mirrors `RecordingsStore` patterns: `macros/` dir with `{id}.json` per macro
(atomic write, parse-or-skip on corrupt individual files), `{id}/assets/`
for embedded target images. `MacroStore::{open, open_at, load_all, save,
delete, sweep_orphan_assets}`. Delete removes json + assets dir.

## Runtime (`src-tauri/src/macros/runner.rs`)

`MacroRunner::start(doc, deps) -> Result<(), String>` on a worker thread;
one run at a time (same claim pattern as `PlaybackEngine`; a macro run and a
plain playback are mutually exclusive — both claim the engine's running
slot).

Per node, in chain order:
- **Segment:** `PlaybackPlan::compile(&events, speed)` → execute through the
  existing simulator/emitter ports. Reuses pacing, SpaceSwitch replay,
  KeyCombo skipping — byte-for-byte the current playback behavior.
- **WaitFor:** loop: evaluate the target against a fresh live grab (same
  code path as the Test-live command); on match → next node; on
  `elapsed >= timeout_ms` → abort. Poll every `poll_interval_ms` (min 100).
  Between polls the stop flag is checked — user stop (Cmd+R / UI) aborts
  within one interval. Match rule per kind: Text → any span's text contains
  `expect` (case-insensitive) when `expect` is Some, else any span at all;
  Template → `matched`; Color → `matched`.

Events (Tauri emits, camelCase payloads): `macro-node-started { macroId,
nodeId, index }`, `macro-node-finished { … }`, `macro-run-finished {
macroId, ok }`, `macro-run-failed { macroId, nodeId, reason }` — reason is
one of `"timeout"`, `"evaluation-error: …"`, `"stopped"`, plus the existing
playback failure surfaces for segment errors.

Testability: the runner takes its dependencies as traits — the existing
`Simulator` port for segments, and a new `WaitProbe` trait
(`fn evaluate(&mut self, target: &Target) -> Result<bool, String>`) so tests
drive wait behavior with a scripted fake (match on Nth poll, error, never)
and a fake clock for timeout math. The real `WaitProbe` wraps LiveSource +
extractors and is thin macOS glue.

## Tauri command surface

- `save_macro(doc) -> MacroDoc` (validates chain before save; template-asset
  copy happens here when a WaitFor target references a recording's template)
- `load_macros() -> Vec<MacroDoc>`
- `delete_macro(id)`
- `run_macro(id) -> Result<(), String>` (validates, claims engine, spawns)
- `stop_macro()` → engine stop (shared with playback stop paths)

All via `observability::trace_command`; registered in `generate_handler!`.

## Error handling

- Validation errors are typed (`MacroError::{NotAChain, UnknownNode,
  EmptyMacro, WaitUnsupportedPlatform, …}`) with stable Display strings (the
  frontend may match on them).
- Runner failures abort the whole run, restore engine idle state, and emit
  `macro-run-failed`; nothing retries silently.
- A WaitFor whose embedded template asset is missing fails at VALIDATION
  (before any input is simulated), not mid-run.

## Testing strategy

- `chain_order`: single node, valid chain, fork, cycle, orphan, dup edge,
  empty — all typed errors pinned.
- Store: round-trip, corrupt-file skip, delete incl. assets, orphan sweep.
- Runner (fake Simulator + fake WaitProbe + fake clock): segment-then-wait
  happy path in order; wait matches on 3rd poll (elapsed = 2×interval);
  timeout aborts with `"timeout"` and no further segment executes; stop
  during wait aborts with `"stopped"`; evaluation error aborts; engine slot
  released on every exit path.
- Serde: MacroDoc round-trip + TS mirror typecheck; unknown future node kind
  in a file → that macro skipped on load with warn (forward compat).
- Real WaitProbe is macOS glue, coverage-excluded (house pattern), verified
  live in sub-project B's first manual run.

## Build order (for the implementation plan)

1. Types + serde + chain validation (pure) + TS mirrors.
2. MacroStore + asset copy + sweep.
3. Runner with fake ports (segments via existing plan machinery).
4. WaitFor evaluation loop + WaitProbe trait + real macOS probe.
5. Tauri commands + engine-slot integration + events.
6. No UI in A (decided): the commands are drivable from the webview devtools
   console for the manual smoke, and sub-project B follows immediately with
   the real canvas. Keeps A purely headless.
