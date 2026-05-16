# ADR 0001: Extract `RecordingsStore` from `lib.rs`

- Status: Accepted
- Date: 2026-05-15

## Context

`recordings.json` persistence was inlined into five separate Tauri command
handlers (`save_recording`, `load_recordings`, `delete_recording`,
`update_recording_name`, `update_recording_speed`) plus a free function
`sweep_orphan_videos`. Each independently resolved `app_data_dir`, joined the
filename, checked existence, read, deserialised, mutated, serialised, and
wrote. Roughly 30 lines of duplicated IO per command.

Worse, "missing file" semantics disagreed: `load_recordings` silently returned
`[]`, while the updaters returned `Err("No recordings found")`. Video file
cleanup on delete lived inside one of the JSON command handlers instead of
with the store that knows what video each id owns.

No tests existed for any of this.

## Decision

Introduce `recordings_store::RecordingsStore` owning `recordings.json` plus the
associated `videos/<id>.mp4` files. Constructor parameters:

- `open(&AppHandle)` — production.
- `open_at(PathBuf)` — test seam (no polymorphic trait).

Public API: `load_all`, `add`, `delete`, `update_name`, `update_speed`,
`sweep_orphan_videos`. Errors are `StoreError { Io, Serde, NotFound,
InvalidSpeed }`; Tauri commands convert to `String` at the boundary.

Writes are atomic (write-to-tempfile + rename) so a process crash mid-write
can't truncate `recordings.json`.

Two updaters use named methods (`update_name`, `update_speed`) rather than a
closure-based `update(id, |r| …)` because at N=2 the explicit names read
better at the call site. Fold into a closure if a third updater appears.

## Consequences

- Five Tauri commands shrink to one-line dispatchers.
- Atomic writes prevent corruption on crash.
- 11 unit tests using `tempfile::tempdir` cover the store directly.
- Future swap to SQLite or another backend touches one module.
- `sweep_orphan_videos` is now adjacent to the data it cleans up.
