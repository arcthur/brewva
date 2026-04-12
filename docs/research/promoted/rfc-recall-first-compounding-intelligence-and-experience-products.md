# Research: Recall-First Compounding Intelligence And Experience Products

## Document Metadata

- Status: `promoted`
- Owner: runtime, deliberation, gateway, and skill-broker maintainers
- Last reviewed: `2026-04-12`
- Promotion target:
  - `docs/architecture/design-axioms.md`
  - `docs/architecture/cognitive-product-architecture.md`
  - `docs/architecture/system-architecture.md`
  - `docs/reference/context-composer.md`
  - `docs/reference/tools.md`
  - `docs/reference/events.md`
  - `docs/reference/artifacts-and-paths.md`
  - `docs/solutions/README.md`

## Promotion Summary

This note is now a short status pointer.

The recall-first compounding-intelligence contract has been promoted into
stable implementation and documentation.

Promoted outcomes:

- hosted default recall is broker-first through `brewva.recall-broker`
- `recall_search` is the default prior-work recall surface and exposes
  stable-id inspection plus source-typed results
- `recall_curate` is the operator-only explicit curation surface
- recall broker state is rebuildable under `.brewva/recall/broker-state.json`
- default cross-session recall scope is `user + repository root`, with
  `session_local` fallback and policy-gated broader scopes
- curation is rebuildable, time-decayed, inspectable, and separated from truth
- typed materialization remains split across `narrative_memory`,
  `skill_promotion`, and `knowledge_capture`
- repository precedent remains explicit and source-typed inside recall rather
  than hidden memory
- recall-specific evaluation now runs through `bun run eval:recall` and
  `bun run eval:recall:summary`

Stable references:

- `docs/architecture/design-axioms.md`
- `docs/architecture/cognitive-product-architecture.md`
- `docs/architecture/system-architecture.md`
- `docs/reference/context-composer.md`
- `docs/reference/tools.md`
- `docs/reference/events.md`
- `docs/reference/artifacts-and-paths.md`
- `docs/solutions/README.md`

## Stable Contract Summary

The promoted contract is:

1. Read-path compounding comes first.
   Broker-first cross-session recall is the default ergonomic prior-work path.
   `tape_search` remains a session-local tape primitive rather than the primary
   recall surface.
2. Utility is advisory, rebuildable, and not truth.
   Curation affects ranking, tie-breaking, and review priority only. It does
   not validate materialization, become kernel truth, or silently widen
   authority.
3. Products stay typed.
   `recall_search` unifies reads; final writes stay in `narrative_memory`,
   `skill_promotion`, and `knowledge_capture`.
4. Recall stays source-typed and scope-bounded.
   Tape evidence, narrative memory, deliberation memory, optimization
   continuity, promotion drafts, and repository precedent remain distinguishable
   and repository-root scoped by default.
5. Promotion stays evidence-first.
   Stable adoption of recall is backed by replay-safe regression coverage and a
   dedicated recall eval corpus rather than intuition alone.

## Validation Status

Promotion is backed by:

- implementation across `@brewva/brewva-recall`, hosted bootstrap, tool
  governance, and stable-doc targets
- regression and contract coverage for operator-only curation, control-plane
  recall availability, repository-root scope isolation, stable-id inspection,
  and curation decay
- repository verification via `bun run check`, `bun test`,
  `bun run test:docs`, and `bun run format:docs:check`
- recall-specific runtime evidence from `bun run eval:recall:summary` on
  `2026-04-12`:
  - baseline precision@k: `25.0%`
  - broker precision@k: `100.0%`
  - useful recall rate: `25.0% -> 100.0%`
  - harmful recall rate: `0.0%`
  - contradiction rate: `0.0%`
  - added startup latency: `8.44 ms`
  - added token cost: `27.3`

## Source Anchors

- `packages/brewva-recall/src/broker.ts`
- `packages/brewva-recall/src/context-provider.ts`
- `packages/brewva-recall/src/session-digests.ts`
- `packages/brewva-tools/src/recall.ts`
- `packages/brewva-gateway/src/host/hosted-session-bootstrap.ts`
- `packages/brewva-gateway/src/runtime-plugins/deliberation-maintenance.ts`
- `test/eval/recall-runtime.ts`
- `test/eval/datasets/recall-cross-session-broker.yaml`

## Remaining Backlog

The following ideas remain intentionally outside the promoted contract:

- broader workspace-wide or cross-workspace recall defaults
- policy changes for worktree sharing beyond the current repository-root default
- materially larger recall corpora or new operational scoring dimensions
- any unified `recall_materialize`-style write surface

If those areas become priorities later, they should start from a new focused
RFC rather than silently widening this promoted pointer.

## Historical Notes

- Long-form option analysis, phased rollout sequencing, and proposal-era
  migration detail were removed from this file after promotion.
- Incubation briefly used broader `experience` terminology, but the stable
  contract is now explicitly `recall_*` end-to-end.
