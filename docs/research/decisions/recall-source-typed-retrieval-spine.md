# Decision: Recall Source-Typed Retrieval Spine

## Metadata

- Decision: `@brewva/brewva-recall` owns source-typed recall product semantics while consuming session-index evidence rows for tape-backed retrieval.
- Date: `2026-05-06`
- Status: accepted
- Stable docs:
  - `docs/architecture/system-architecture.md`
  - `docs/reference/tools/memory-and-recall.md`
  - `skills/project/shared/package-boundaries.md`
  - `skills/project/shared/source-map.md`
  - `docs/research/decisions/recall-first-compounding-intelligence-and-experience-products.md`
- Code anchors:
  - `packages/brewva-recall/src/index.ts`
  - `packages/brewva-recall/src/public/index.ts`
  - `packages/brewva-recall/src/broker/index.ts`
  - `packages/brewva-recall/src/context/index.ts`
  - `packages/brewva-recall/src/knowledge/index.ts`
  - `packages/brewva-recall/src/evidence/index.ts`
  - `packages/brewva-recall/src/broker/broker.ts`
  - `packages/brewva-recall/src/broker/tape-evidence.ts`
  - `test/quality/retrieval-spine-boundaries.quality.test.ts`

## Decision Summary

- Recall root exports shared vocabulary and result types only; broker, context, knowledge, and evidence implementations live on explicit package subpaths.
- Recall owns ranking, trust labels, evidence strength, curation, stable IDs, source mapping, hosted context rendering, and repository precedent search.
- Recall consumes `SessionIndexTapeEvidence.searchText` and no longer reconstructs indexed event search text or owns a duplicate indexed tape event allowlist.
- The non-DuckDB session digest fallback is removed; the rebuildable DuckDB session index is the recall read model for prior-session tape evidence.

## Superseded by

- None.
