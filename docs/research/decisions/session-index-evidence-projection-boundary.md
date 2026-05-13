# Decision: Session Index Evidence Projection Boundary

## Metadata

- Decision: `@brewva/brewva-session-index` owns rebuildable indexed evidence projection from event tape into typed DuckDB query rows.
- Date: `2026-05-06`
- Status: accepted
- Stable docs:
  - `docs/architecture/system-architecture.md`
  - `docs/reference/artifacts-and-paths.md`
  - `docs/reference/tools/memory-and-recall.md`
  - `skills/project/shared/package-boundaries.md`
  - `skills/project/shared/source-map.md`
  - `docs/research/decisions/duckdb-session-query-plane.md`
- Code anchors:
  - `packages/brewva-session-index/src/index.ts`
  - `packages/brewva-session-index/src/public/index.ts`
  - `packages/brewva-session-index/src/api.ts`
  - `packages/brewva-session-index/src/evidence/index.ts`
  - `packages/brewva-session-index/src/projection/session.ts`
  - `packages/brewva-session-index/src/query/digests.ts`
  - `packages/brewva-session-index/src/query/tape-evidence.ts`
  - `packages/brewva-session-index/src/duckdb/lifecycle.ts`
  - `test/fitness/retrieval-spine-boundaries.fitness.test.ts`

## Decision Summary

- Session-index root exports typed public contracts; DuckDB lifecycle, schema, query, projection, lease, snapshot, and SQL mechanics remain private implementation modules.
- Query APIs accept raw `query` strings and call `tokenizeSearchQuery` internally, while event/session materialization calls `tokenizeSearchContent`.
- `@brewva/brewva-session-index/evidence` is the controlled repo-owned subpath for indexed tape event types and search-text construction.
- DuckDB session-index files are rebuildable state only; schema version bumps use writer catch-up and rewrite from event tape rather than durable migration scripts.

## Superseded by

- None.
