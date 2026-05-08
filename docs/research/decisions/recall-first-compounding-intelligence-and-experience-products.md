# Decision: Recall-First Compounding Intelligence And Experience Products

## Metadata

- Decision: Read-path compounding comes first. Broker-first cross-session recall is the default ergonomic prior-work path. `tape_search` remains a session-local tape primitive rather than the primary recall surface.
- Date: `2026-04-12`
- Status: accepted
- Stable docs:
  - `docs/architecture/design-axioms.md`
  - `docs/architecture/cognitive-product-architecture.md`
  - `docs/architecture/system-architecture.md`
  - `docs/reference/context-composer.md`
  - `docs/reference/tools.md`
  - `docs/reference/events/README.md`
  - `docs/reference/artifacts-and-paths.md`
  - `docs/solutions/README.md`
- Code anchors:
  - `packages/brewva-recall/src/broker/broker.ts`
  - `packages/brewva-recall/src/context/provider.ts`
  - `packages/brewva-session-index/src/factory.ts`
  - `packages/brewva-tools/src/families/memory/recall.ts`
  - `packages/brewva-gateway/src/host/hosted-session-bootstrap.ts`
  - `packages/brewva-gateway/src/runtime-plugins/deliberation-maintenance.ts`
  - `test/eval/recall-runtime.ts`
  - `test/eval/datasets/recall-cross-session-broker.yaml`

## Decision Summary

- Read-path compounding comes first. Broker-first cross-session recall is the default ergonomic prior-work path. `tape_search` remains a session-local tape primitive rather than the primary recall surface.
- Utility is advisory, rebuildable, and not truth. Curation affects ranking, tie-breaking, and review priority only. It does not validate materialization, become kernel truth, or silently widen authority.
- Products stay typed. `recall_search` unifies reads; final writes stay in `narrative_memory`, `skill_promotion_inspect` / `skill_promotion_review` / `skill_promotion_promote`, and `knowledge_capture`.
- Recall stays source-typed and scope-bounded. Tape evidence, narrative memory, deliberation memory, optimization continuity, promotion drafts, and repository precedent remain distinguishable and repository-root scoped by default.
- Promotion stays evidence-first. Stable adoption of recall is backed by replay-safe regression coverage and a dedicated recall eval corpus rather than intuition alone.

## Superseded by

- None.
