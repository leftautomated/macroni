# Macro Canvas (Sub-Project B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A visual macro canvas as a third Studio view: build/arrange/connect Segment + text-Wait nodes, save, run with live node highlighting, stop. Spec: `docs/superpowers/specs/2026-07-06-macro-canvas-design.md`.

**Architecture:** Pure adapters/logic (chain check, doc↔react-flow mapping, connect guard) are unit-tested; the `useMacros` hook owns command calls + event subscription + run state; `MacroCanvas` is thin glue over `@xyflow/react`; `MacroEditor` composes it into a new `view` in `StudioEditor`. All backend commands/events from sub-project A are used verbatim — no backend changes.

**Tech Stack:** React 19, `@xyflow/react` 12.11.2 (already installed), vitest + RTL, Tauri invoke/listen.

## Global Constraints

- **No backend changes.** Uses `load_macros`, `save_macro`, `delete_macro`, `run_macro`, `stop_macro` and events `macro-node-started`/`macro-node-finished`/`macro-run-finished`/`macro-run-failed` exactly as A defined them.
- **Linear-chain only:** `isLinearChain` gates Run + drives the validity banner; backend `save_macro` remains authoritative.
- **Mutual exclusion:** Run disabled while a run is active; `run_macro` "Already playing" surfaces as a toast.
- **Node positions persist** via `MacroNode.x/y`.
- **react-flow isn't unit-rendered** (jsdom lacks the layout APIs it needs): test the pure adapters + hook logic; the canvas glue is verified by `pnpm typecheck` + the Task 6 manual smoke.
- **No perception revival** (that's C); `PERCEPTION_STUDIO_UI` stays false.
- TS types (from A, in `src/types.ts`): `MacroDoc`, `MacroNode`, `MacroNodeKind` (`{type:"Segment",events,speed,provenance?}` | `{type:"WaitFor",target,timeout_ms,poll_interval_ms}`), `MacroEdge {from,to}`, `MacroProvenance {recording_id,start_ms,end_ms}`, `PerceptionTarget`, `InputEvent`, `Recording`.
- Event field casing is camelCase on the wire: `{ macroId, nodeId, index }`, `{ macroId, ok }`, `{ macroId, nodeId, reason }`.
- Checks per task: `pnpm vitest run src`, `pnpm typecheck`, `pnpm lint:fix`. Style: double quotes, semicolons (biome).

## File Structure

- `src/lib/macro-chain.ts` (+test) — `isLinearChain`.
- `src/lib/macro-flow.ts` (+test) — `docToFlow`, `flowToDoc`, `canConnect`, `nodeSummary`.
- `src/hooks/useMacros.ts` (+test) — commands + events + run state.
- `src/components/studio/macros/SegmentNodeView.tsx`, `WaitNodeView.tsx`, `MacroCanvas.tsx` (glue).
- `src/components/studio/macros/AddNodePanel.tsx` (+test).
- `src/components/studio/macros/MacroToolbar.tsx`, `MacrosMenu.tsx`, `MacroEditor.tsx`.
- `src/components/studio/StudioEditor.tsx` (MODIFY — `view` union).

---

### Task 1: `isLinearChain` (pure)

**Files:** Create `src/lib/macro-chain.ts`, `src/lib/macro-chain.test.ts`.

**Interfaces (Produces):** `export function isLinearChain(doc: Pick<MacroDoc, "nodes" | "edges">): boolean` — true iff nodes form exactly one path visiting each once (mirrors backend `chain_order`: single node ok; empty false; fork/cycle/orphan false; unknown/self edge false).

- [ ] **Step 1: Failing tests:**

```ts
import { describe, expect, it } from "vitest";
import { isLinearChain } from "./macro-chain";

const n = (id: string) => ({ id, kind: { type: "Segment" as const, events: [], speed: 1 }, x: 0, y: 0 });
const chain = (ids: string[], edges: Array<[string, string]>) => ({
  nodes: ids.map(n),
  edges: edges.map(([from, to]) => ({ from, to })),
});

describe("isLinearChain", () => {
  it("accepts a single node and a valid chain in any node order", () => {
    expect(isLinearChain(chain(["a"], []))).toBe(true);
    expect(isLinearChain(chain(["c", "a", "b"], [["a", "b"], ["b", "c"]]))).toBe(true);
  });
  it("rejects empty, fork, cycle, orphan, unknown, self", () => {
    expect(isLinearChain(chain([], []))).toBe(false);
    expect(isLinearChain(chain(["a", "b", "c"], [["a", "b"], ["a", "c"]]))).toBe(false); // fork
    expect(isLinearChain(chain(["a", "b"], [["a", "b"], ["b", "a"]]))).toBe(false); // cycle
    expect(isLinearChain(chain(["a", "b"], []))).toBe(false); // orphan pair
    expect(isLinearChain(chain(["a"], [["a", "ghost"]]))).toBe(false); // unknown
    expect(isLinearChain(chain(["a"], [["a", "a"]]))).toBe(false); // self
  });
});
```

- [ ] **Step 2:** `pnpm vitest run src/lib/macro-chain.test.ts` → FAIL.
- [ ] **Step 3: Implement:**

```ts
import type { MacroDoc } from "@/types";

/** True iff the nodes form exactly one linear path (backend chain_order shape). */
export function isLinearChain(doc: Pick<MacroDoc, "nodes" | "edges">): boolean {
  const { nodes, edges } = doc;
  if (nodes.length === 0) return false;
  const ids = new Set(nodes.map((n) => n.id));
  const outOf = new Map<string, string>();
  const inDeg = new Map<string, number>();
  for (const e of edges) {
    if (!ids.has(e.from) || !ids.has(e.to) || e.from === e.to) return false;
    if (outOf.has(e.from)) return false; // fork (second out-edge)
    outOf.set(e.from, e.to);
    inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1);
    if ((inDeg.get(e.to) ?? 0) > 1) return false; // converging
  }
  const starts = nodes.filter((nd) => (inDeg.get(nd.id) ?? 0) === 0);
  if (nodes.length === 1) return edges.length === 0;
  if (starts.length !== 1) return false; // cycle → 0 starts; orphan → >1
  let cur: string | undefined = starts[0].id;
  const seen = new Set<string>();
  while (cur !== undefined) {
    if (seen.has(cur)) return false;
    seen.add(cur);
    cur = outOf.get(cur);
  }
  return seen.size === nodes.length;
}
```

- [ ] **Step 4:** `pnpm vitest run src && pnpm typecheck && pnpm lint:fix` → PASS.
- [ ] **Step 5: Commit** `git add src/lib/macro-chain.ts src/lib/macro-chain.test.ts && git commit -m "feat(macros): linear-chain check for the canvas"`

---

### Task 2: doc↔flow adapters + connect guard (pure)

**Files:** Create `src/lib/macro-flow.ts`, `src/lib/macro-flow.test.ts`.

**Interfaces (Produces):**
- `import type { Node, Edge } from "@xyflow/react";`
- `export function docToFlow(doc: MacroDoc): { nodes: Node[]; edges: Edge[] }` — each `MacroNode` → `{ id, type: kind.type === "Segment" ? "segment" : "wait", position: { x, y }, data: { node } }` (data carries the original `MacroNode`); each `MacroEdge` → `{ id: \`${from}->${to}\`, source: from, target: to }`.
- `export function flowToDoc(base: MacroDoc, nodes: Node[], edges: Edge[]): MacroDoc` — writes back positions (`x/y` from `node.position`) and edges (`{ from: e.source, to: e.target }`); node kinds/data unchanged (keeps `base.nodes` order by id, updating x/y).
- `export function canConnect(edges: Edge[], source: string, target: string): boolean` — false if `source === target`, or source already has an out-edge, or target already has an in-edge (enforces linear on the canvas).
- `export function nodeSummary(node: MacroNode): string` — Segment: `\`${events.length} events · ${dur}s\`` (dur = (last−first ts)/1000, 1dp, 0 if <2 events); WaitFor: text → `\`wait: "${expect}" · ${timeout_ms/1000}s\`` (expect ?? "any text"), template → `"wait: image"`, color → `"wait: color"`.

- [ ] **Step 1: Failing tests** — cover: docToFlow maps types/positions/edge-ids; flowToDoc round-trips positions + edges and preserves kinds; canConnect rejects self / existing-out / existing-in and accepts a fresh link; nodeSummary for a 3-event segment (assert "3 events") and a text wait (assert `wait: "Go"`).
- [ ] **Step 2:** RED.
- [ ] **Step 3: Implement** per the interfaces.
- [ ] **Step 4:** checks PASS.
- [ ] **Step 5: Commit** `git commit -am "feat(macros): react-flow doc adapters and connect guard"`

---

### Task 3: `useMacros` hook

**Files:** Create `src/hooks/useMacros.ts`, `src/hooks/__tests__/useMacros.test.ts`.

**Interfaces (Produces):** `useMacros()` returns:
- `macros: MacroDoc[]`, `load(): Promise<void>`
- `save(doc: MacroDoc): Promise<MacroDoc>` (returns the asset-rewritten doc; refreshes list)
- `remove(id): Promise<void>`, `run(id): Promise<void>`, `stop(): Promise<void>`
- `runState: "idle" | "running"`, `liveNodeId: string | null`, `failed: { nodeId: string; reason: string } | null`
- Uses `invoke` from `@/lib/observability`; subscribes with `listen` from `@tauri-apps/api/event` to the four events (always mounted): `macro-node-started` → `liveNodeId = payload.nodeId`, `runState = "running"`, clear `failed`; `macro-node-finished` → (leave live until next start; clearing optional); `macro-run-finished` → `runState = "idle"`, `liveNodeId = null`; `macro-run-failed` → `runState = "idle"`, `failed = { nodeId, reason }`, `liveNodeId = null`. `run` sets `runState="running"` optimistically and rethrows invoke errors (caller toasts).

- [ ] **Step 1: Failing tests** (mock `@/lib/observability` invoke + `@tauri-apps/api/event` listen with a listener registry, like `src/__tests__/App.test.tsx`):
  - `load` populates `macros` from `load_macros`.
  - firing `macro-node-started {nodeId:"n2"}` sets `liveNodeId="n2"` and `runState="running"`.
  - firing `macro-run-failed {nodeId:"n2",reason:"timeout"}` sets `failed` and `runState="idle"`.
  - `save` calls `save_macro` with `{ doc }` and returns the resolved doc.
- [ ] **Step 2:** RED.
- [ ] **Step 3: Implement.** Event subscription in a mount `useEffect([])`; cleanup unlistens. Payload types: `{ macroId: string; nodeId: string; index: number }` / `{ macroId: string; ok: boolean }` / `{ macroId: string; nodeId: string; reason: string }`.
- [ ] **Step 4:** checks PASS.
- [ ] **Step 5: Commit** `git commit -am "feat(macros): useMacros hook with live run events"`

---

### Task 4: node views + `MacroCanvas` glue

**Files:** Create `SegmentNodeView.tsx`, `WaitNodeView.tsx`, `MacroCanvas.tsx` under `src/components/studio/macros/`.

**Interfaces:**
- Consumes: `docToFlow`/`flowToDoc`/`canConnect`/`nodeSummary` (Task 2).
- `MacroCanvas` props: `{ doc: MacroDoc; liveNodeId: string | null; failedNodeId: string | null; onChange: (doc: MacroDoc) => void; onSelectionChange?: (nodeId: string | null) => void }`.
- Node views are `@xyflow/react` custom nodes registered via `nodeTypes = { segment: SegmentNodeView, wait: WaitNodeView }` (module-const, not re-created per render). Each renders a dark card with `nodeSummary(data.node)`, a `Handle` type="target" (left) + type="source" (right), and a running/failed border (`data.live` / `data.failed` booleans injected in `docToFlow` mapping OR read via a prop). Use the `data` payload to carry `live`/`failed`: extend `docToFlow` usage in the canvas to set `data.live = node.id === liveNodeId`, `data.failed = node.id === failedNodeId`.

- [ ] **Step 1:** No unit test for ReactFlow rendering (jsdom limitation — documented in the spec). Instead extend `macro-flow.test.ts` with a test for a small pure helper `withRunState(flowNodes, liveNodeId, failedNodeId)` that sets `data.live`/`data.failed` — add that helper to `macro-flow.ts` and test it (RED first).
- [ ] **Step 2:** RED on `withRunState`.
- [ ] **Step 3: Implement** `withRunState` + the three components. `MacroCanvas`: `const [flowNodes, setFlowNodes] = useNodesState(...)` seeded from `docToFlow(doc)`; on node drag stop / edge change → `onChange(flowToDoc(doc, nodes, edges))`; `onConnect` guarded by `canConnect` (reject + no-op if false); `deleteKeyCode` enabled so selected node/edge deletes; wrap in `<ReactFlowProvider>`; include `<Background />` + `<Controls />`. Apply `withRunState` before passing nodes to `<ReactFlow>`.
- [ ] **Step 4:** `pnpm vitest run src && pnpm typecheck && pnpm lint:fix` → PASS (typecheck is the real gate for the glue).
- [ ] **Step 5: Commit** `git commit -am "feat(macros): canvas with segment and wait node views"`

---

### Task 5: `AddNodePanel`

**Files:** Create `AddNodePanel.tsx` (+`AddNodePanel.test.tsx`) under `macros/`.

**Interfaces:** Props `{ recordings: Recording[]; onAdd: (node: MacroNode) => void }`. Two forms:
- *Add Segment:* `<select>` of `recordings` (those with `.video`), start/end seconds number inputs (bounded 0..duration; end>start). On add: filter the recording's `events` to `e.timestamp` within `[start_ms, end_ms]` where the ms are relative to the recording's video `start_ms` (use `video.start_ms + start*1000`); build `MacroNode { id: crypto.randomUUID(), kind: { type: "Segment", events: filtered, speed: 1, provenance: { recording_id, start_ms, end_ms } }, x: 40, y: 40 }`.
- *Add Text Wait:* text input (`expect`, required non-empty) + timeout seconds (default 10). On add: `MacroNode { id, kind: { type: "WaitFor", target: { id: crypto.randomUUID(), name: expect, modality: "visual", region: { x:0,y:0,w:1,h:1 }, kind: { type: "TextOcr", expect }, created_at: Date.now() }, timeout_ms: timeout*1000, poll_interval_ms: 500 }, x: 40, y: 160 }`.

- [ ] **Step 1: Failing tests:** Add Segment with a recording whose events span 0–5s and a range 1–3s yields a node whose `events` are exactly those in range and correct provenance; Add Text Wait with "Submit"/8 builds the exact `TextOcr` target shape and `timeout_ms: 8000`; empty text disables its Add button.
- [ ] **Step 2:** RED.
- [ ] **Step 3: Implement.** (Event ms filtering: a recording's events use absolute-ish timestamps — use the same relative basis the timeline uses: `e.timestamp - (video.start_ms ?? recording.created_at)` compared against `[start*1000, end*1000]`. Store the resulting node's provenance ms in that same relative space.)
- [ ] **Step 4:** checks PASS.
- [ ] **Step 5: Commit** `git commit -am "feat(macros): add-node panel for segments and text waits"`

---

### Task 6: `MacroToolbar` + `MacrosMenu` + `MacroEditor` + StudioEditor integration

**Files:** Create `MacroToolbar.tsx`, `MacrosMenu.tsx`, `MacroEditor.tsx` under `macros/`; MODIFY `src/components/studio/StudioEditor.tsx`.

**Interfaces:**
- `MacroToolbar` props `{ dirty: boolean; valid: boolean; runState: "idle"|"running"; onSave; onRun; onStop }` — Save (shows a dot when dirty), Run (disabled when `!valid || runState==="running"`), Stop (shown when running); a validity banner when `!valid`.
- `MacrosMenu` props `{ macros; selectedId; onSelect; onCreate; onDeleteClick; confirmDeleteId }` — mirrors `RecordingsMenu` (two-click delete). Create prompts a name (inline input; default "Untitled Macro").
- `MacroEditor` — the view: `useMacros()` + local working-doc state (seeded from the selected macro, dirty on edit); composes `MacrosMenu` (title-bar `left` slot when in macros view), `MacroToolbar`, `AddNodePanel`, `MacroCanvas`. Save → `save(workingDoc)`; on save/select refresh working doc from the returned/selected doc. Run gated on `isLinearChain(workingDoc) && runState==="idle"`; Run/Stop call `run(selectedId)`/`stop()`; toast errors (reuse the app's existing toast/logEvent — if no toast component exists, surface errors inline in the toolbar banner).
- `StudioEditor` refactor: replace `showSettings: boolean` with `view: "player" | "settings" | "macros"`. The gear sets `view` to toggle settings; a new title-bar button (icon `Workflow` or `Share2` from lucide) toggles macros. Body renders `MacroEditor` when `view === "macros"`, settings when `"settings"`, else the player/timeline. The `MacrosMenu` shows in the title-bar `left` slot when in macros view (replacing `RecordingsMenu` there), else `RecordingsMenu` as today.

- [ ] **Step 1: Failing tests:** `MacroToolbar` — Run disabled when `valid=false`; Run disabled + Stop shown when `runState="running"`; Save shows dirty dot. `StudioEditor` — clicking the macros title-bar button shows the macro view (query for a macros-view marker, e.g. the toolbar's Run button) and hides the player; existing settings/player tests still pass (update the `showSettings`→`view` internal without breaking their assertions).
- [ ] **Step 2:** RED.
- [ ] **Step 3: Implement** toolbar, menu, editor, and the `view` refactor. Keep the existing settings and player behavior identical (only the internal state shape changes).
- [ ] **Step 4:** `pnpm vitest run src && pnpm typecheck && pnpm lint:fix` → PASS (all prior Studio tests green).
- [ ] **Step 5: Manual smoke (controller/user):** `pnpm tauri dev` → Studio → Macros view → create a macro → Add Segment from a recording (range covering some clicks) → Add Text Wait → connect Segment→Wait → Save → Run: the segment replays, the Wait node pulses while polling, and it completes (if the text is on screen) or fails with "timeout". Confirm Run is disabled until the chain is valid, and disabled during playback.
- [ ] **Step 6: Commit** `git commit -am "feat(macros): macro editor view wired into the studio"`

---

## Spec-coverage checklist (self-review)

- Linear check → Task 1. Doc↔flow + connect guard + summaries + run-state decoration → Tasks 2/4. Hook: commands + 4 events + run/live/failed state → Task 3. Canvas + node views + live highlight → Task 4. Segment-from-recording + text-wait authoring → Task 5. Toolbar/menu/editor + `view` refactor + integration + smoke → Task 6.
- Type consistency: `MacroNode`/`MacroNodeKind` shapes match `src/types.ts`; event payload casing camelCase in Tasks 3; `docToFlow`/`flowToDoc`/`withRunState` names consistent Tasks 2↔4.
- Deferred (absent): timeline snipping, template/color wait authoring, perception revival, branching, run history — all C or later.
