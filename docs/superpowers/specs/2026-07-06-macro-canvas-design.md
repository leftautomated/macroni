# Macro Canvas — Sub-Project B Design

**Program:** Macro graph (see `2026-07-05-macro-graph-runtime-design.md`).
Sub-project A (headless model + linear runtime) is complete. **B adds the
visual canvas** — a third Studio view where you build, arrange, save, and run
macros as a node graph, with nodes lighting up live during a run.

**Scope boundary with C:** B ships node *mechanics* + enough authoring to be
usable end-to-end: create a Segment node from a recording (pick recording +
time range via numeric inputs) and a text Wait node (type the text to wait
for — no template asset needed). C later adds richer authoring: snipping a
segment by dragging on the video timeline, and template/color Wait authoring
via the region-select UI (reviving the paused perception components).

---

## Global Constraints

- **Library:** `@xyflow/react` (react-flow v12; supports React 19). Add as a
  frontend dependency. No other new deps.
- **Reuses sub-project A's commands verbatim:** `load_macros`, `save_macro`,
  `delete_macro`, `run_macro`, `stop_macro`, and the `macro-node-started` /
  `macro-node-finished` / `macro-run-finished` / `macro-run-failed` events.
  No backend changes in B.
- **Linear-chain only (v1):** the canvas allows a single connected path.
  Invalid graphs are surfaced (banner + disabled Run) before save; the
  backend remains the authority (`save_macro` rejects with its typed error).
- **Mutual exclusion respected:** Run/Stop reflect the shared engine slot —
  a macro run and playback can't both be active; the UI disables Run while a
  run (or playback) is in flight and re-enables on the terminal event.
- **Node positions persist:** `MacroNode.x/y` (already in the model) are
  written on drag so layouts survive reload.
- **No perception-component revival here:** template/color wait authoring and
  video-timeline snipping are C. `PERCEPTION_STUDIO_UI` stays false.
- **Style:** matches the Studio's dark theme; double quotes, semicolons,
  biome-enforced. Tests: vitest + RTL.

## Studio integration

Refactor `StudioEditor`'s `showSettings: boolean` into a `view: "player" |
"settings" | "macros"` union (a small, contained change; the gear toggles
settings, a new title-bar control toggles macros). The Macros view replaces
the player/timeline body when active. A `MacrosMenu` (mirroring
`RecordingsMenu`) in the title bar picks/creates/deletes macros.

## Components (`src/components/studio/macros/`)

- **`MacroCanvas.tsx`** — wraps `@xyflow/react` `<ReactFlow>`; maps a
  `MacroDoc` to react-flow nodes/edges and back. Owns: node drag →
  position update, `onConnect` (linear guard: reject a connection whose
  source already has an out-edge or target an in-edge, with a toast),
  edge/node deletion, selection. Custom node types `segment` and `wait`.
- **`SegmentNodeView.tsx` / `WaitNodeView.tsx`** — custom node renderers:
  a titled card summarizing the node (Segment: "N events · 3.2s · from
  <recording>"; Wait: "wait for 'Submit' · 10s"), one target + one source
  handle, and a **running** visual state (pulsing border) driven by the
  live node-id.
- **`MacrosMenu.tsx`** — title-bar dropdown: list macros, create (empty
  named macro), select, delete (two-click like RecordingsMenu).
- **`AddNodePanel.tsx`** — a side/inline panel with two forms:
  - *Add Segment:* recording `<select>` (video recordings) + start/end
    seconds inputs (validated within the recording's duration) → builds a
    Segment node whose `events` are the recording's events filtered to
    `[start_ms, end_ms]` with `provenance` set.
  - *Add Text Wait:* text input (`expect`) + timeout seconds → a WaitFor
    node with a `TextOcr { expect }` target (region = full frame `{0,0,1,1}`,
    a generated target id, modality Visual). No asset.
- **`MacroToolbar.tsx`** — Save (dirty indicator), Run/Stop (state-aware),
  validity banner ("Not a linear chain — connect nodes end to end").
- **`MacroEditor.tsx`** — the view container: holds the working `MacroDoc`
  state, wires `useMacros`, composes canvas + toolbar + add panel.

## State & data flow (`src/hooks/useMacros.ts`)

- `load()` → `invoke("load_macros")`; `save(doc)` → `invoke("save_macro",
  { doc })` returns the (asset-rewritten) doc; `remove(id)`; `run(id)` /
  `stop()`.
- Subscribes to the four `macro-*` events: `macro-node-started` sets the
  live node id (canvas highlights it), `macro-node-finished` clears/advances,
  `macro-run-finished`/`macro-run-failed` end the run (failed → toast with
  `reason`, highlight the failing node red).
- Run state: `idle | running`; Run disabled when running OR when the doc is
  not a valid linear chain (client-side check mirroring `chain_order`).
- Working-doc edits (add/move/connect/delete) mark dirty; Save persists.
  IDs generated with `crypto.randomUUID()`.

## Client-side chain check (`src/lib/macro-chain.ts`)

`isLinearChain(doc): boolean` — a pure TS mirror of the backend
`chain_order` shape check (one start, one end, single path, no fork/cycle),
used to gate Run and drive the validity banner without a round-trip. Backend
stays authoritative on save.

## Error handling

- Save/run/stop failures → toast with the backend error string (the typed
  `MacroError` Displays are stable). No silent failures.
- `run_macro` "Already playing" (engine busy) → toast "Stop playback first".
- A run that fails mid-way (`macro-run-failed`) highlights the reported
  `nodeId` and shows the `reason`.

## Testing

- `isLinearChain` — pure: valid chain, fork, cycle, orphan, single node,
  empty (mirrors the backend's `chain_order` cases).
- `MacroCanvas` — onConnect linear guard (second out-edge rejected); node
  drag emits a position update; delete removes node+incident edges.
- `AddNodePanel` — Add Segment filters events to the range and sets
  provenance; Add Text Wait builds the correct `TextOcr` target shape;
  invalid ranges disabled.
- `useMacros` — event subscription updates live node id and run state
  (mock `invoke`/`listen` like the App/Studio tests); run gated on validity.
- `MacroToolbar` — Run disabled when invalid/running; Save dirty state.
- (react-flow's own rendering isn't unit-tested; we test our adapters and
  logic. A manual smoke drives a real run with live highlighting.)

## Build order (for the plan)

1. `@xyflow/react` dep + `isLinearChain` pure lib + tests.
2. `useMacros` hook (load/save/run/stop + event subscription + run state).
3. `MacroCanvas` + node views (display, drag, connect-guard, delete).
4. `AddNodePanel` (segment-from-recording + text-wait forms).
5. `MacroToolbar` + `MacrosMenu` + validity/run wiring.
6. `MacroEditor` container + StudioEditor `view` refactor + integration;
   manual smoke (build a 2-node macro, run, watch highlight).

## Deferred to C
Video-timeline segment snipping; template/color wait authoring via
region-select; the perception-component revival; run history; branching.
