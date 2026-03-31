# Research: Repository-Native Compound Knowledge Plane and Review Ensemble

## Document Metadata

- Status: `promoted`
- Owner: runtime maintainers
- Last reviewed: `2026-03-31`
- Promotion target:
  - `docs/architecture/system-architecture.md`
  - `docs/architecture/cognitive-product-architecture.md`
  - `docs/architecture/design-axioms.md`
  - `docs/reference/skills.md`
  - `docs/reference/tools.md`
  - `docs/guide/category-and-skills.md`
  - `docs/guide/features.md`
  - `docs/solutions/README.md`

## Promotion Summary

This note is now a short status pointer.

Repository-native compound knowledge and the internal review ensemble have been
promoted into stable Brewva documentation and implementation. This was a major
system update because it changed the canonical home of repository precedent,
made precedent retrieval an explicit control-plane protocol, and formalized
multi-lane review behind the existing `review` boundary without widening runtime
authority.

Stable implementation now includes:

- `docs/solutions/**` as the canonical repository-native precedent store
- `knowledge_search` as the explicit, query-intent-aware precedent retrieval
  surface
- `learning-research` and `planning_posture` as the planning-time proof-of-consult
  path for non-trivial work
- `knowledge-capture` as deterministic terminal materialization of canonical
  solution records from typed artifacts
- `precedent_audit` and `precedent_sweep` as explicit authority-overlap,
  same-rank-conflict, and stale-routing maintenance surfaces
- a single public `review` skill with internal multi-lane reviewer execution and
  parent-controlled synthesis
- no `runtime.knowledge.*` public domain and no hidden default knowledge
  injection into the hosted path

Stable references:

- `docs/architecture/system-architecture.md`
- `docs/architecture/cognitive-product-architecture.md`
- `docs/architecture/design-axioms.md`
- `docs/reference/skills.md`
- `docs/reference/tools.md`
- `docs/guide/category-and-skills.md`
- `docs/guide/features.md`
- `docs/solutions/README.md`

## Stable Contract Summary

The promoted contract is:

1. `docs/solutions/**` is the canonical cold repository precedent layer.
2. Precedent retrieval is explicit and query-intent-aware through
   `knowledge_search`; hidden recall does not become authority.
3. Non-trivial planning and review preserve proof-of-consult through
   `learning-research`, `precedent_query_summary`, and
   `precedent_consult_status`.
4. Bug-fix and incident capture requires investigation-grade typed artifacts
   before a solution record can claim failed-attempt lineage.
5. `review` remains one public skill even when internal reviewer lanes fan out;
   lane activation, missing evidence, and residual blind spots stay visible in
   the synthesized `review_report`.
6. Contradictions between stable docs, active precedents, and runtime evidence
   must stay explicit through `precedent_audit`, `precedent_sweep`, and review
   disclosure rather than being silently flattened by recency.
7. Runtime authority, proposal boundaries, and effect governance remain
   unchanged. Repository-native compound knowledge is adjacent to the kernel,
   not part of kernel authority.

## Validation Status

Promotion is backed by:

- unit and contract coverage for `knowledge_search` authority ranking, sparse
  bootstrap behavior, source typing, and query-intent-aware ordering
- `knowledge-capture`, `precedent_audit`, and `precedent_sweep` coverage for
  investigation-grade capture, derivative routing, higher-authority overlap, and
  same-rank conflict handling
- review-ensemble protocol and synthesis coverage for deterministic lane
  activation, missing-evidence widening, and structured disclosure
- workflow derivation and skill-contract coverage for `planning_posture`,
  `learning-research`, and `review_report`
- stable doc coverage and full regression coverage across the current repository

## Remaining Backlog

The following ideas are intentionally not part of the promoted contract:

- new kernel-owned repository-governance authority
- hidden default precedent injection into the hosted path
- a public `runtime.knowledge.*` API family
- broader productization beyond the current precedent, planning, review, and
  maintenance surfaces

If future work changes those boundaries, it should begin from a new focused RFC
rather than reopening this promoted status pointer.

## Archive Notes

- Historical option analysis, rollout phases, and temporary validation criteria
  were removed from this file after promotion.
- The stable contract now lives in architecture, reference, guide, and solution
  docs plus regression tests rather than in `docs/research/`.
