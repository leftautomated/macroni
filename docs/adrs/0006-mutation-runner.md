# ADR 0006: Adopt mutation testing on the deepened modules

- Status: Accepted
- Date: 2026-05-16

## Context

The coverage gate (ADR-0005) measures "what's exercised." It says nothing
about whether the exercise verifies anything. Concrete evidence the
distinction matters: `src/hooks/__tests__/smoke.test.ts` asserts
`expect(1 + 1).toBe(2)` — a test file that shipped, counted as coverage,
and verifies nothing.

Mutation testing introduces small program changes ("mutants") and runs the
suite against each. A mutant that survives is a place where the suite
covers code but doesn't actually assert anything about it.

A baseline run on the four deepened modules surfaced real gaps:

- `recording_session.rs` — no test asserted the `Display` impl for
  `SessionError` (frontend reads those strings verbatim across the Tauri
  boundary).
- `recordings_store.rs` — same `Display` gap, plus an off-by-one boundary
  on `update_speed` (no test pinned the `speed > 1000` vs `>= 1000`
  decision).
- `playback/plan.rs` — 13 missed mutants on first run, including the
  speed-2.0 boundary, the `>50ms` throttling boundary, and the
  `event_time - prev_time` vs `+` subtraction in the throttle filter.

All real assertions worth adding; none were captured by 64.97% line
coverage.

## Decision

Adopt `cargo-mutants` as the mutation runner, scoped to the four deepened
modules (`recordings_store`, `event_capture`, `recording_session`,
`playback/plan`, `playback/engine`) via `src-tauri/mutants.toml`. The Tauri
command surface (`lib.rs`), key mappings, settings, and capture/encoder
modules are out of scope — those need acceptance tests (ADR-0007), not
mutation tests.

Equivalent mutants (where no test could distinguish original and mutant
behaviour) are explicitly listed in `mutants.toml`'s `exclude_re` with a
comment explaining the equivalence. As of adoption: one such mutant —
`PlaybackPlan::compile`'s `actual > 0` check where `actual` is
mathematically guaranteed to be ≥ 1.

CI gate posture (`.github/workflows/test.yml`):

- **Pull requests**: run `cargo mutants --in-diff <PR diff>`. Only files
  changed in the PR are mutated; runtime stays under a few minutes.
- **Push to main**: run the full scoped sweep. Hard gate — any missed
  mutant fails the build.

Both run as a separate `mutation` job alongside the existing test and
coverage jobs.

## Consequences

- Adoption-time fixes: 7 new tests added across the deepened modules
  pinning Display strings, boundary conditions, sanitize_speed branches,
  and the throttle subtraction. All are real assertions, not noise.
- Future PRs that touch a deepened module must either kill every mutant
  cargo-mutants finds or document the equivalence in `mutants.toml`.
- Out-of-scope modules (Tauri commands, capture, key mappings) are
  uncovered by this gate. ADR-0007 (acceptance tests) covers them at the
  end-to-end level instead.

## Why scope to the deepened modules?

- They have the highest assertion-density (90%+ line coverage); mutation
  testing pays off most where coverage is already good.
- The Tauri command surface needs runtime context (`AppHandle`, real OS
  permissions) that mutation testing can't drive — acceptance tests are
  the right tool there.
- A full-codebase mutation sweep would take ~40 minutes; scoped runs are
  in the 4–8 minute range.

## Why hard gate on PRs?

- Mutation testing is the *only* gate that proves new tests actually
  assert. Without a hard gate, tests degrade silently — the smoke.test.ts
  pattern returns.
- `--in-diff` keeps the PR runtime tractable. Full sweeps run on `main`
  pushes for visibility.
