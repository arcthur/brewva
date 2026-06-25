# Decision: Session-Index Read-Model Engine

## Metadata

- Decision: The session index is a rebuildable read model (not durable truth) over the event tape, carried by SQLite (`bun:sqlite`) + FTS5, replacing DuckDB. Its long-term asset is an engine-agnostic temporal-knowledge-graph + hybrid-retrieval contract on `SessionIndexQueryPort`; the engine is a replaceable carrier under it.
- Date: `2026-06-25`
- Status: accepted
- Stable docs:
  - `docs/architecture/system-architecture.md`
  - `docs/reference/artifacts-and-paths.md`
  - `docs/reference/tools/memory-and-recall.md`
  - `docs/reference/working-projection.md`
  - `docs/reference/events/harness.md`
- Code anchors:
  - `packages/brewva-session-index/src/schema/sql.ts`
  - `packages/brewva-session-index/src/sqlite/instance.ts`
  - `packages/brewva-session-index/src/sqlite/lifecycle.ts`
  - `packages/brewva-session-index/src/sqlite/surrogate.ts`
  - `packages/brewva-session-index/src/query/digests.ts`
  - `packages/brewva-session-index/src/query/fts.ts`
  - `packages/brewva-session-index/src/query/tape-evidence.ts`
  - `packages/brewva-session-index/src/projection/session.ts`
  - `packages/brewva-session-index/src/projection/events.ts`
  - `packages/brewva-session-index/src/factory.ts`
  - `test/unit/session-index/query-contract.unit.test.ts`
  - `test/unit/session-index/surrogate.unit.test.ts`
  - `test/unit/session-index/rebuild-equivalence.unit.test.ts`
  - `test/fitness/session-index-read-model-discipline.fitness.test.ts`

## Decision Summary

- The session index is rebuildable state, not durable truth: deleting the on-disk index and reprojecting from the event tape is a no-data-loss operation, which is why the engine choice never locks the system in and there is no migration or backward-compatibility requirement.
- The engine is SQLite (`bun:sqlite`, WAL) + FTS5, replacing DuckDB (`@duckdb/node-api`). The load read from the code is OLTP plus lexical retrieval — point lookups, scoped `IN` filters, ordered-limit lists, recursive parent-pointer walks, and inverted-index ranking — every one a row-store/B-tree/recursive-CTE/FTS5 fit, none an OLAP columnar fit.
- Retrieval: each `@brewva/brewva-search` token is surrogate-encoded into an ASCII-safe opaque symbol before storage, and query terms are encoded identically, so the FTS5 virtual tables (`session_fts`, `event_fts`, `ascii` tokenizer) are a true passthrough and never re-tokenize the jieba CJK segmentation that `@brewva/brewva-search` already produced. Ranking is `bm25()` normalized to `[0,1]` (logistic `1/(1+exp(bm25))`), replacing the old hand-rolled `count(distinct token)` coverage score; the normalized score preserves the `[0,1]` relevance the recall broker blends with freshness and root overlap.
- The contract is the durable asset, the engine a replaceable carrier: the read model is a temporal knowledge graph (projection-layer lineage parent pointers + cross-session delegation edges) with hybrid retrieval (temporal cursor order, lexical FTS5, a declared-but-unbuilt vector seam), expressed engine-agnostically on `SessionIndexQueryPort`. The contract is named forward but implemented only at today's shape.
- Concurrency is single-writer-per-session election (write-lease) plus WAL multi-reader: readers open the live database directly, so the DuckDB-era reader-snapshot machine (`publishReadSnapshot`, the `snapshots/` directory, the manifest, and pruning) is deleted, not ported.
- A full rebuild, including a schema-version bump, runs in one transaction (posture A): readers keep the prior consistent index until that single commit and never observe a cleared or half-built view. Steady-state per-session upserts are already atomic and unchanged.
- Tokenization stays owned by `@brewva/brewva-search`; no package outside it owns tokenizer mechanics. FTS5 owns only the inverted storage and the ranking. The surrogate step makes the boundary hold regardless of FTS5 tokenizer internals; the round-trip is asserted by a CJK index-then-query test.
- Architecture consequence: the engine is bun-runtime-bound (`bun:sqlite` + `bun-types`), but `bun:sqlite` is value-imported lazily at the database-open boundary (`sqlite/instance.ts`), so the package import graph stays Node-loadable and degrades to an `unavailable` status under Node instead of hard-crashing the import — matching the dist verifier's Node-safe contract (`script/verify-dist.ts`) and the `internal-shell-runtime` stub precedent.
- Deferred, with explicit triggers:
  - WS2 versioned incremental migration is deliberately deferred. Schema bumps use the single-transaction full rebuild today; implement incremental migration only when full-rebuild cost becomes painful at real history size (its reason is rebuild cost, not consistency, so it is decoupled from posture A).
  - `Turso Database` is a future option behind two gates (supply: GA plus tantivy/vector out of experimental; demand: a labeled quality harness shows SQLite + FTS5 has topped out and the gap is engine-layer). Its MVCC headline is off-target for a single-writer-by-design projection, so the move would be a rebuild, not a migration; no shadow adapter is pre-built.
  - Semantic recall via `sqlite-vec` is a future lexical-vs-semantic decision, gated on a labeled harness with a specified method and minimum N; only the declared vector seam exists now.

## Axioms

These obey `docs/architecture/design-axioms.md`:

- Obeys `Subtraction beats switches` (axiom 3): the engine swap is net subtraction — a native-addon engine, the reader-snapshot/manifest/prune machine, a hand-rolled retrieval scorer, and a build/verify native-asset special-case all leave; the temporal-KG and vector arms are forward-named declared seams, not forward-built code; Turso and `sqlite-vec` are not pre-built behind toggles.
- Obeys `Adaptive logic stays out of the kernel` (axiom 2): retrieval ranking moves from a hand-maintained coverage score to FTS5 `bm25()` inside the deliberation-ring read model, never into the kernel; the index remains rebuildable, non-authoritative state.
- Obeys `Same evidence is not shared authority` (axiom 11): the read model is reprojected from the same tape evidence and never becomes replay truth or widens kernel, capability, source, or adoption authority; the single-writer election keeps one projector without collapsing tape authority into the index.

## Superseded by

- None.
