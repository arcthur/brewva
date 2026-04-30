# Research: Stateful Box Plane And BoxLite Execution Runtime

## Document Metadata

- Status: `archived`
- Owner: runtime, tools, and distribution maintainers
- Last reviewed: `2026-04-26`
- Promotion target:
  - `docs/architecture/invariants-and-reliability.md`
  - `docs/architecture/system-architecture.md`
  - `docs/reference/configuration.md`
  - `docs/reference/events/README.md`
  - `docs/reference/exec-threat-model.md`
  - `docs/reference/runtime.md`
  - `docs/reference/tools.md`
  - `docs/solutions/security/exec-command-policy-and-readonly-shell.md`
  - `docs/research/decisions/stateful-box-plane-and-boxlite-execution-runtime.md`

## Archive Summary

This note archives the migration rationale for replacing the old microsandbox
execution path with Brewva's current stateful BoxLite-backed box plane.

The lasting migration decisions were:

- model isolated execution as scoped boxes rather than one-command sandboxes
- remove the remote sandbox service mental model instead of hiding BoxLite
  behind `backend="sandbox"` compatibility names
- create `@brewva/brewva-box` as the quarantine boundary around BoxLite SDK
  shapes, lifecycle, snapshots, forks, detached executions, and inventory
- keep `exec` focused on shell-command policy, target-root checks, result
  shaping, and tool evidence rather than sandbox lifecycle ownership
- reject automatic host fallback and make host execution explicit
- remove `security.execution.sandbox.*`, `backend="sandbox"`,
  `backend="best_available"`, `fallbackToHost`,
  `security.credentials.sandboxApiKeyRef`, and `MSB_SERVER_URL`
- keep BoxLite state operational and non-authoritative; replay truth remains in
  event tape, receipts, WAL/recovery records, and stable runtime contracts
- keep DuckDB session-index state rebuildable even when it summarizes box
  lifecycle and inventory
- publish only native binary targets with BoxLite support

## Current Stable References

Read current behavior from:

- `docs/architecture/invariants-and-reliability.md`
- `docs/architecture/system-architecture.md`
- `docs/reference/configuration.md`
- `docs/reference/events/README.md`
- `docs/reference/exec-threat-model.md`
- `docs/reference/runtime.md`
- `docs/reference/tools.md`
- `docs/solutions/security/exec-command-policy-and-readonly-shell.md`
- `docs/research/decisions/stateful-box-plane-and-boxlite-execution-runtime.md`

Current stable docs and code now carry the contract that this RFC migrated
toward:

- BoxLite-backed `BoxPlane` implementation under `@brewva/brewva-box`
- `security.execution.backend="box"` as the default isolated route
- fail-fast rejection of sandbox-era config fields
- scoped stateful boxes for isolated execution
- detached execution, snapshots, forks, release, inventory, and maintenance
- binary packaging aligned with BoxLite native support

## Why Keep This Note

This archive remains useful when you need the historical rationale for:

- why Brewva did not preserve `sandbox` / `best_available` compatibility names
- why stateful execution belongs behind a box plane package rather than inside
  `exec`
- why BoxLite state is inspectable operational substrate state, not replay
  authority
- why native release targets narrowed when the box plane became default

## Historical Notes

- Full proposal text, option analysis, surface-budget detail, and rollout
  sequencing were removed from the promoted status pointer after promotion.
- Use git history if you need the original draft detail or intermediate
  microsandbox-to-BoxLite migration reasoning.
