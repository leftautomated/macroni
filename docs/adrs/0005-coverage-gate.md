# ADR 0005: Adopt coverage gate (Rust + frontend) with ratchet baseline

- Status: Accepted
- Date: 2026-05-16

## Context

Before this ADR there was no coverage measurement at all. `vitest.config.ts`
had no `coverage` block; `cargo test` ran without `tarpaulin`/`llvm-cov`.
Adoption of the orchestrator (ADR-0006) made every other gate visible, but
"is there code in `src/` that isn't exercised by any test?" was unanswerable.

Realistic numbers at adoption:

- **Rust:** 64.97% lines / 60.16% functions across `src-tauri/src/**`. The
  four deepened modules (recordings_store, event_capture, recording_session,
  playback/{plan,engine}) sit between 83% and 96%. The 0% files are the
  Tauri command surface (`lib.rs`), `main.rs`, `permissions.rs` —
  legitimately uncoverable from `cargo test` without an `AppHandle`.
- **Frontend:** 7.88% lines / 6.28% functions across `src/**`. Four test
  files exist; 11 user-facing components have none.

## Decision

Adopt two coverage gates, configured **at the current baseline minus a
small buffer** (ratchet posture). The gates can only move up; never down.

- **Rust:** `cargo llvm-cov --fail-under-lines 62 --summary-only` runs in a
  new `coverage` job on macOS. 3-point buffer below the 65% baseline.
- **Frontend:** `vitest run --coverage` enforces `vitest.config.ts`
  thresholds. Set just below the real numbers (lines: 7, statements: 7,
  functions: 6, branches: 6) so the gate fires on regression but doesn't
  churn on rounding. Excludes test files, the shadcn ui/ directory,
  main.tsx (entry), and the vite env type file.

Both gates run as hard CI steps with no `continue-on-error`.

## Consequences

- A PR that drops Rust line coverage below 62% fails CI.
- A PR that drops *frontend* line coverage below 7% fails CI. (Yes, the
  threshold is low — it's a baseline, not an aspiration. ADR-0006 captures
  the work to ratchet it up.)
- The deepened Rust modules (90%+ coverage today) are now protected against
  regression — adding a function to `playback/plan.rs` without a test will
  pull the average down toward the gate.
- The 0% files in Rust (`lib.rs`, `permissions.rs`) limit how high the gate
  can rise without acceptance tests (ADR-0007). Together with the
  acceptance harness, the gate ratchets upward as those entry points get
  end-to-end coverage.

## Why not a per-file threshold or per-PR changed-lines gate?

- **Per-file:** vitest doesn't natively support it; would require a custom
  step. Total-coverage ratchet is cheaper to maintain and catches most
  regressions.
- **Per-PR changed lines:** requires reading `git diff` against the base
  ref inside CI and walking it through the coverage report — meaningful
  cost for a hobby-scale repo. Revisit when the project is bigger.

## When to bump the threshold

Whenever a PR reports total coverage above the gate by more than 5 points
for two consecutive commits on `main`, bump the gate to the lower of the
two by 3. Document the bump in the commit message.
