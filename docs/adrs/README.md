# Architecture Decision Records

Short records of significant architectural decisions. Each ADR captures the
context that the code itself can't tell you: what was wrong before, what we
changed, and what that bought us.

| # | Title | Status |
|---|---|---|
| [0001](0001-recordings-store.md) | Extract `RecordingsStore` from `lib.rs` | Accepted |
| [0002](0002-event-capture.md) | Extract `EventCapture` from the rdev listener closure | Accepted |
| [0003](0003-playback-plan-engine.md) | Split playback into `PlaybackPlan` + `PlaybackEngine` | Accepted |
| [0004](0004-recording-session.md) | Consolidate active-recording state into `RecordingSession` | Accepted |
| [0005](0005-coverage-gate.md) | Adopt coverage gate (Rust + frontend) with ratchet baseline | Accepted |

## Conventions

- Number ADRs sequentially: `NNNN-kebab-title.md`.
- Keep each ADR short. Context → Decision → Consequences. No filler.
- Update Status if a later ADR supersedes an earlier one.
