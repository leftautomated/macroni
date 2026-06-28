# ADR 0008: Adopt Tauri log plugin observability with traced IPC

- Status: Accepted
- Date: 2026-06-26

## Context

Before this ADR, the app had ad hoc diagnostics: some `eprintln!` calls in
Rust, some `console.error` calls in React, and a panic crash log. That was
not enough to debug a feature failure end to end. A recording issue could
start in the React control panel, cross the Tauri IPC boundary, touch screen
capture, recording storage, playback, or studio export, and leave no shared
identifier across those layers.

The stack already has idiomatic observability pieces:

- Tauri v2 provides the official log plugin for Rust logs, webview logs, log
  directory handling, filtering, and file rotation.
- Tauri's `tracing` feature instruments internal app lifecycle, plugin,
  event, IPC, and custom protocol activity.
- Rust libraries already compose around the `log` facade; a desktop app does
  not need a custom JSONL writer just to get durable local diagnostics.
- Browser APIs provide high-resolution User Timing measures and long-task
  observation without adding a monitoring service.

## Decision

Use the official Tauri logging path as the durable sink and keep app-specific
observability as a thin facade.

Concretely:

- Register `tauri-plugin-log` with file rotation and the Webview target.
- Enable Tauri's `tracing` feature and the plugin's `tracing` feature.
- Add `src-tauri/src/observability.rs` to standardize app event JSON,
  command start/finish/error timing, slow-command warnings, and diagnostics
  snapshot data.
- Route Rust diagnostics through `log` instead of `eprintln!`.
- Add `src/lib/observability.ts` as the only frontend IPC wrapper. It injects
  a `traceId` into every command, records User Timing marks/measures, emits
  slow/pending/error events, and forwards structured frontend logs through
  `@tauri-apps/plugin-log`.
- Add a Settings diagnostics panel that fetches
  `get_diagnostics_snapshot`, displays local log locations, and copies the
  snapshot as JSON.

This keeps the app offline-first and desktop-native: no SaaS collector,
no server dependency, and no extra privacy surface.

## Consequences

- A frontend action, Tauri command, Rust subsystem event, and diagnostics
  snapshot can now share a `traceId`.
- Local support/debugging starts with the Settings diagnostics panel and the
  app log directory managed by Tauri.
- Every new Tauri command should accept `trace_id: Option<String>` and be
  wrapped in `observability::trace_command`.
- New frontend code should import `invoke` from `@/lib/observability`, not
  directly from `@tauri-apps/api/core`.
- This does not replace real crash reporting or remote metrics. If the app
  later needs opt-in remote telemetry, it should be added behind the same
  frontend/backend facades instead of leaking provider APIs through features.

## References

- Tauri log plugin: https://v2.tauri.app/plugin/logging/
- Tauri `tracing` feature: https://docs.rs/tauri
- Rust `tracing` model: https://docs.rs/tracing/latest/tracing/
- MDN User Timing: https://developer.mozilla.org/en-US/docs/Web/API/Performance_API/User_timing
- React Profiler: https://react.dev/reference/react/Profiler
