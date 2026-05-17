# ADR 0007: Adopt acceptance specs at the React+hooks layer; defer true Tauri E2E

- Status: Accepted
- Date: 2026-05-16

## Context

Before this ADR there were no acceptance specs at all. Frontend unit tests
covered individual components; Rust unit tests covered modules. Nothing
exercised a user-visible flow end-to-end. Concrete risks the gap left open:

- Tauri command-name typos compile on both sides separately and only fail
  at runtime ("invoke('start-recording')" instead of "start_recording" —
  a silent break under cargo test + pnpm test).
- Payload shape drift between Rust types and TypeScript types (e.g.,
  field renames in `Recording`).
- User-flow regressions ("expand → switch to Recordings tab → see empty
  state").

True cross-process E2E (Rust ↔ JavaScript over real Tauri IPC) requires
`tauri-driver` plus a WebDriver runner — fiddly to wire on macOS/Windows
matrix, ~10× slower than vitest, and the binary version-pinning is brittle
against Tauri minor releases. The cost is meaningful for a hobby-scale
project; the marginal coverage benefit is mostly IPC contract drift.

## Decision

Adopt acceptance specs at the **React+hooks integration layer**, not the
real Tauri IPC layer. Concretely:

- `src/acceptance/*.acceptance.test.tsx` — vitest+jsdom tests that mount
  `<App />` and drive it through `@testing-library/user-event`.
- The Tauri IPC surface (`@tauri-apps/api/core`, `@tauri-apps/api/event`,
  `@tauri-apps/api/webviewWindow`) is mocked with an in-memory
  `fakeBackend` that the test reads and writes against.
- Each scenario describes a user-visible flow ("when X happens, then Y
  appears in the DOM") and asserts against the rendered output, not
  component internals.

The first three scenarios at adoption:

1. Empty state on the Recordings tab when no recordings exist.
2. A seeded recording surfaces in the list after expand + tab switch.
3. Clicking Start dispatches `start_recording` to the (mocked) backend.

These run under the existing `pnpm test` step. They count toward the
coverage gate (ADR-0005) — `App.tsx` and `RecordingsList.tsx` both gain
exercise from this layer.

True Tauri E2E (`tauri-driver`) is **explicitly deferred**, not abandoned.
The remaining gap — IPC contract drift between Rust command signatures
and TS invoke calls — is mitigated, not closed, by:

- The Rust architecture checker (ADR-0003) enforcing the Tauri command
  surface boundary.
- The "error strings are stable" tests added during ADR-0006 (mutation
  testing) — these pin the user-visible error text that crosses the IPC
  boundary verbatim.

## Consequences

- A user-flow regression that breaks any of the three scenarios fails
  CI. Examples: the expand toggle stops working, the Recordings tab
  removes its empty-state copy, `start_recording` stops being invoked
  from the Start button.
- The IPC contract is *not* fully verified — a typo in a Tauri command
  name on either side still slips through. This is the deferred work.
- Adding scenarios is cheap (vitest+jsdom is already in the suite). No
  new CI tooling needed.
- When the project graduates beyond hobby scale, revisit by promoting
  `src/acceptance/` to `tests/e2e/` with `tauri-driver` and keeping the
  current files as a "fast acceptance" inner ring.

## Naming convention

- File suffix: `*.acceptance.test.tsx` so the layer is greppable.
- Directory: `src/acceptance/` to keep it separate from unit tests in
  `__tests__/`.
- Test name format: "describes user-visible behaviour" — e.g., "shows
  the empty state on the Recordings tab when no recordings exist".

## Rollback

If the acceptance scenarios become a maintenance burden (e.g., a UI
refactor breaks 8 scenarios in one PR), the rollback is to delete
`src/acceptance/` — the unit and integration layers continue to gate.
Don't loosen the assertions; delete the scenario or rewrite it.
