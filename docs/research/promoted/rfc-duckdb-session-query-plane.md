# Research: DuckDB Session Query Plane

## Document Metadata

- Status: `promoted`
- Owner: runtime, recall, CLI, and distribution maintainership
- Last reviewed: `2026-04-24`
- Promotion target:
  - `docs/architecture/system-architecture.md`
  - `docs/reference/artifacts-and-paths.md`
  - `docs/reference/commands.md`
  - `docs/reference/configuration.md`
  - `docs/reference/tools.md`

## Promotion Summary

This note is now a promoted status pointer. The accepted decision is to use a
local DuckDB-backed session query plane as Brewva's rebuildable, typed query
model for cross-session recall and insights.

The promoted contract is:

- event tape remains the only replay, receipt, and recovery authority
- `@brewva/brewva-session-index` owns the DuckDB adapter, schema, catch-up,
  token indexing, snapshot reads, and writer lease
- runtime exposes only read-only event-log inspection needed by the index and
  does not depend on DuckDB
- recall and insights consume typed APIs; no user-facing SQL surface is exposed
- tokenization stays centralized in `@brewva/brewva-search`
- if native DuckDB cannot load or no readable snapshot exists, indexed products
  fail closed with `session_index_unavailable`; runtime construction, replay,
  event inspection, and core CLI help remain available

## Stable Contract Summary

1. `.brewva/session-index/session-index.duckdb`,
   `.brewva/session-index/read-snapshot.json`, and
   `.brewva/session-index/snapshots/*.duckdb` are rebuildable state, not durable
   truth.
2. The session index stores `sessions`, `session_target_roots`, `events`,
   `event_tokens`, `session_tokens`, and `index_state`.
3. `session_tokens` contains task and digest tokens plus aggregated
   `event_text` tokens, so recall stage 1 can select long sessions even when a
   matching event is outside the digest summary window.
4. `session_target_roots` is the root-overlap query surface; JSON root arrays
   are not used for scoped filtering.
5. One writer updates the primary DuckDB file under a heartbeat lease.
   Non-writer processes read the latest published snapshot when available.
6. `recall_search` uses the index for scoped session candidates and tape
   evidence retrieval. The broker still owns final ranking, curation,
   trust labels, stable ids, and rendering.
7. Recall curation durability comes from tape-visible feedback and utility
   events. Broker aggregates are rebuildable in-memory ranking state.
8. `brewva insights` uses the index for recent-session window selection and
   reports index diagnostics. Deeper SQL-backed aggregation remains future
   product work, not a promotion blocker.
9. v1 has no public session-index config flag and no compatibility commitment
   to the removed internal JSON recall cache or Fuse-only multi-session scans.

## Validation Status

Promotion is backed by current regression coverage for:

- session-index schema creation, token indexing, snapshot reads, catch-up,
  corrupted-index handling, rebuild/reset behavior, and writer lease behavior
- recall broker indexed candidate and evidence retrieval, stable-id lookup,
  curation-owned ranking, and filtered dirty invalidation
- runtime event-log inspection contract without raw append exposure
- CLI insights indexed window selection and index diagnostics
- distribution verification for native DuckDB assets, including the Linux x64
  binary help smoke in Docker

Current verification commands used during promotion:

- `bun run check`
- `bun test test/unit/session-index/session-index.unit.test.ts test/unit/recall/broker.unit.test.ts --timeout 120000`
- `bun test test/contract/tools/session-coordination.contract.test.ts --timeout 120000`
- `bun run test:dist`
- `BREWVA_BINARY_TARGETS=bun-linux-x64 bun run build:binaries`
- Docker Linux x64 `brewva --help` and `brewva --version` smoke checks
- `bun run format:docs:check`
- `bun run test:docs`

## Source Anchors

- `packages/brewva-session-index/src/index.ts`
- `packages/brewva-recall/src/broker.ts`
- `packages/brewva-runtime/src/runtime.ts`
- `packages/brewva-cli/src/insights.ts`
- `script/build-binaries.ts`
- `script/verify-dist.ts`
- `docs/reference/artifacts-and-paths.md`
- `docs/reference/commands.md`
- `docs/reference/configuration.md`
- `docs/reference/tools.md`

## Remaining Backlog

- Measure catch-up latency and snapshot publication cost on very large real
  workspaces.
- Consider a long-lived maintenance worker if query-triggered catch-up stops
  meeting product latency budgets.
- Evaluate a DuckDB WASM adapter only if native package coverage blocks a
  supported target.
- Move more `brewva insights` repeated-event and finding aggregation paths to
  SQL-backed typed queries.
- Define the eventual output-search artifact query plane separately from this
  session query plane.

## Historical Notes

The original active RFC compared direct DuckDB JSONL reads with a materialized
query plane. The promoted design chose materialization because Brewva needs
typed query APIs, centralized tokenization, root-overlap filtering, stable
snapshots for non-writer processes, and fail-closed behavior when native DuckDB
is unavailable.
