# Decision: DuckDB Session Query Plane

## Metadata

- Decision: `.brewva/session-index/session-index.duckdb`, `.brewva/session-index/read-snapshot.json`, and `.brewva/session-index/snapshots/*.duckdb` are rebuildable state, not durable truth.
- Date: `2026-04-24`
- Status: accepted
- Stable docs:
  - `docs/architecture/system-architecture.md`
  - `docs/reference/artifacts-and-paths.md`
  - `docs/reference/commands.md`
  - `docs/reference/configuration.md`
  - `docs/reference/tools.md`
- Code anchors:
  - `packages/brewva-session-index/src/index.ts`
  - `packages/brewva-session-index/src/factory.ts`
  - `packages/brewva-recall/src/broker/broker.ts`
  - `packages/brewva-runtime/src/runtime/runtime.ts`
  - `packages/brewva-cli/src/insights.ts`
  - `script/build-binaries.ts`
  - `script/verify-dist.ts`

## Decision Summary

- `.brewva/session-index/session-index.duckdb`, `.brewva/session-index/read-snapshot.json`, and `.brewva/session-index/snapshots/*.duckdb` are rebuildable state, not durable truth.
- The session index stores `sessions`, `session_target_roots`, `events`, `event_tokens`, `session_tokens`, and `index_state`.
- `session_tokens` contains task and digest tokens plus aggregated `event_text` tokens, so recall stage 1 can select long sessions even when a matching event is outside the digest summary window.
- `session_target_roots` is the root-overlap query surface; JSON root arrays are not used for scoped filtering.
- One writer updates the primary DuckDB file under a heartbeat lease. Non-writer processes read the latest published snapshot when available.
- Session-index schema version bumps do not require migration scripts: the index is rebuildable, the writer opens the existing DuckDB file, rewrites rows from the event tape, and publishes fresh read snapshots for the current schema.

## Superseded by

- `docs/research/decisions/session-index-read-model-engine.md` (engine superseded: SQLite + FTS5 replaces DuckDB; the rebuildable-state semantics are kept by the successor).
