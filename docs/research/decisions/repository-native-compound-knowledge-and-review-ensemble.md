# Decision: Repository-Native Compound Knowledge Plane and Review Ensemble

## Metadata

- Decision: `docs/solutions/**` is the canonical cold repository precedent layer.
- Date: `2026-03-31`
- Status: accepted
- Stable docs:
  - `docs/architecture/system-architecture.md`
  - `docs/architecture/cognitive-product-architecture.md`
  - `docs/architecture/design-axioms.md`
  - `docs/reference/skills.md`
  - `docs/reference/tools.md`
  - `docs/guide/category-and-skills.md`
  - `docs/guide/features.md`
  - `docs/solutions/README.md`
- Code anchors:
  - `N/A`

## Decision Summary

- `docs/solutions/**` is the canonical cold repository precedent layer.
- Precedent retrieval is explicit and query-intent-aware through `knowledge_search`; hidden recall does not become authority.
- Non-trivial planning and review preserve proof-of-consult through `learning-research`, `precedent_query_summary`, and `precedent_consult_status`.
- Bug-fix and incident capture requires investigation-grade typed artifacts before a solution record can claim failed-attempt lineage.
- `review` remains one public skill even when internal reviewer lanes fan out; lane activation, missing evidence, and residual blind spots stay visible in the synthesized `review_report`.

## Superseded by

- None.
