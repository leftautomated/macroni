# Space-Switch & Swipe Capture — Design

**Goal:** Recordings capture window/Space switching (three-finger swipes,
⌃arrows, Mission Control — any cause) as first-class events and replay them
correctly, and the Studio timeline labels in-app two-finger swipes. Also:
the perception annotation UI is removed from the Studio pending its own
redesign (backend collection unaffected).

**Why now:** a recorded 3-finger swipe is currently invisible to the event
tap, so replayed macros perform every subsequent action on the wrong
Space/window — silent, total macro breakage.

**Accuracy is the binding constraint** (explicit user requirement): exact
direction and hop count from Space ordering (never gesture heuristics),
dedup rules chosen to minimize expected error, and swipe labeling tuned so
false positives are structurally impossible over false negatives.

---

## Global Constraints

- **macOS only.** The observer, CGS listing, and replay shortcuts are macOS
  concepts; all new native code is `#[cfg(target_os = "macos")]` behind the
  same seams as existing platform glue. Non-macOS builds compile unchanged.
- **Private API, pinned as a risk:** direction/count derive from
  `CGSCopyManagedDisplaySpaces` + `CGSMainConnectionID` (the ordering AltTab
  and yabai have used across macOS versions for years). If it breaks in a
  future macOS, capture degrades to "no SpaceSwitch events" — never wrong
  ones (list-read failure → skip, log warn).
- **Semantic capture, not kinematics.** The gesture itself is unobservable by
  public or private API at the event-tap layer; we record the resulting
  switch. Gesture speed/finger count are out of scope.
- **Replay precondition (documented):** stock Mission Control shortcuts
  ⌃←/⌃→ ("Move left/right a space") must be enabled — macOS default.
- **Backward compatible:** `InputEvent` gains one variant; old recordings
  deserialize unchanged (serde tagged enum, additive).
- **Never destabilize capture/playback:** observer failures log and no-op;
  the event tap, encoder, and perception tee are untouched.
- **In-app swipe replay is explicitly deferred:** synthetic wheel events
  carry no gesture phases, so browser back/forward swipes cannot be
  faithfully re-triggered; raw scroll replay (status quo) is retained.
  Recognition is display-only, in the frontend.

---

## 1. `SpaceSwitch` event

```rust
// types.rs InputEvent (serde tag = "type", PascalCase — house style)
SpaceSwitch {
    direction: String, // "left" | "right"
    count: u32,        // hops — a fast multi-Space swipe records count: 2
    timestamp: i64,
},
```

TS mirror in `src/types.ts` (`InputEventType.SpaceSwitch`).

### Capture (`space_watch.rs`, macOS-only, coverage-excluded native glue)

- At app startup, register an `NSWorkspace.activeSpaceDidChangeNotification`
  observer on the main run loop. It is registered once and lives for the app;
  it forwards into the existing event channel only while
  `RecordingSession::is_active()`.
- On notification: read `CGSCopyManagedDisplaySpaces`, locate the display
  whose active space changed, and compute `new_index - old_index` within that
  display's ordered space list (order IS left-to-right order):
  - `delta < 0` → `direction: "left"`, `count = |delta|`
  - `delta > 0` → `direction: "right"`, `count = delta`
  - `delta == 0` or space not found or CGS failure → skip + `log_warn`
    (accuracy rule: never emit a guessed direction).
- Previous state (per-display active space id) is cached by the watcher and
  refreshed on every notification and at recording start.
- Multi-display: v1 records switches on whichever display changed; complex
  multi-display choreography is out of scope.
- The index-delta → (direction, count) computation is a pure function
  (`space_delta(old_idx, new_idx) -> Option<(Direction, u32)>`) — unit
  tested; only the observer/CGS shell is native glue.

### Dedup (accuracy-critical)

Keyboard-initiated switches are already captured as KeyCombos and replay on
their own; the notification would double them (replay = two jumps).

- Rule: drop a `SpaceSwitch` arriving within **500 ms** after a captured
  **known space-changing trigger**: ⌃← / ⌃→ combos and the Mission Control
  key. Everything else is kept.
- Rejected alternative (documented deliberately): suppressing after *any*
  recent key/click would silently drop the common "click, then immediately
  swipe away" sequence. The chosen rule's only failure mode — a Dock click
  that lands on another Space records both the click and a SpaceSwitch — is
  rarer, and still replays correctly once when the app layout matches
  (the click reproduces the jump; the extra SpaceSwitch is the known,
  documented residual — revisit with real data).
- Implemented as a pure gate (`SwitchDedup { note_trigger(ts), admit(ts) ->
  bool }`) owned by the event collector — unit tested with fake timestamps.

### Replay

`PlaybackPlan::compile` maps `SpaceSwitch { direction, count }` →
`count` repetitions of ⌃arrow press/release (`ControlLeft` +
`LeftArrow`/`RightArrow`), using the same inter-key pacing KeyCombos use.
Recording gaps already contain the Space animation time, so subsequent
events don't race the transition. Tested through the existing fake-simulator
harness (assert exact key sequence for count 1 and 2, both directions).

### Studio timeline

`SpaceSwitch` renders as a distinct `⇄` tick on the keys lane (tooltip:
"Space right ×2"), plus a legend entry. Included in `event-utils` grouping
as a discrete event.

---

## 2. In-app two-finger swipe labeling (frontend only)

In `src/lib/event-utils.ts` scroll grouping: label a scroll group **Swipe ←/→**
only when ALL hold (conservative — false positives are the failure mode that
matters; borderline cases stay labeled "Scroll"):

- `|Σ delta_x| ≥ 3 × |Σ delta_y|` (decisively horizontal),
- group duration ≤ 400 ms (a fling, not a pan),
- `|Σ delta_x|` ≥ a floor (tuned against real captures; start 30 units).

No data-model change, no replay change. Unit tests: clear fling → Swipe;
diagonal scroll, slow horizontal pan, small jiggle → Scroll.

---

## 3. Perception UI paused in the Studio

Pending a dedicated annotation-UX design (separate brainstorm):

- `const PERCEPTION_STUDIO_UI = false` in `StudioEditor.tsx` gates: passing
  `targets`/`spans`/`hasObservations` to the player, loading/passing
  observations and `perceptionTicks`, rendering `PerceptionPanel`, and the
  target-authoring callbacks (drag becomes inert — click-to-play unaffected).
- Everything below the UI stays: continuous-OCR collection (still opt-in in
  Settings), sidecar storage, Tauri commands, all perception components and
  their tests (they test components directly with props).
- Editor-level tests assert the perception surfaces are absent with the flag
  off; re-enabling during the redesign is a one-line flip.

---

## Testing Strategy

Pure/CI-safe core, native shell excluded (house pattern):

- `space_delta` — direction/count for ±1, ±2, 0, not-found.
- `SwitchDedup` — inside/outside window, non-trigger events don't suppress,
  boundary at exactly 500 ms.
- Plan compilation — SpaceSwitch → exact ⌃arrow sequences (count 1 and 2,
  both directions) via the fake simulator.
- Serde round-trip + legacy recordings without the variant load unchanged;
  TS mirror typechecks.
- Swipe labeling thresholds incl. rejection cases.
- Editor flag-off tests.
- `space_watch.rs` joins the coverage exclusion regex; manual verification:
  record → 3-finger swipe left/right (single and fast-double) → stop →
  timeline shows ⇄ ticks → replay returns to the right Space; plus a
  ⌃arrow-initiated switch records exactly one event.

## Build order

1. `SpaceSwitch` variant + TS mirror + serde/legacy tests.
2. `space_delta` + `SwitchDedup` pure logic with tests.
3. `space_watch.rs` observer + CGS shell; wire into collector with dedup.
4. Replay compilation + simulator tests.
5. Timeline `⇄` rendering + legend.
6. Swipe labeling in event-utils + tests.
7. Perception UI flag + editor test updates.
