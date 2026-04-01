# Research: Narrative Memory Product and Bounded Semantic Recall

## Document Metadata

- Status: `promoted`
- Owner: runtime maintainers
- Last reviewed: `2026-04-01`
- Promotion target:
  - `docs/architecture/system-architecture.md`
  - `docs/architecture/cognitive-product-architecture.md`
  - `docs/reference/runtime.md`
  - `docs/reference/context-composer.md`
  - `docs/reference/tools.md`
  - `docs/reference/artifacts-and-paths.md`
  - `docs/reference/events.md`
  - `docs/guide/features.md`

## Promotion Summary

This note is now a short status pointer.

The narrative-memory product and bounded semantic recall path have been
promoted into stable implementation and documentation.

Promoted outcomes:

- a sibling `NarrativeMemoryPlane` with explicit, provenance-bearing storage at
  `.brewva/deliberation/narrative-memory-state.json`
- an explicit `narrative_memory` operator surface distinct from
  `deliberation_memory`
- a shared validation boundary for explicit `remember` and passive extraction
- bounded semantic extraction and ambiguity-gated semantic rerank in the hosted
  control plane only
- source-floor and elastic-recall context budgeting
- control-plane audit receipts for narrative-memory lifecycle and semantic
  assistance
- stable docs that keep narrative memory non-authoritative and distinct from
  repository-native precedent under `docs/solutions/**`

Stable references:

- `docs/architecture/system-architecture.md`
- `docs/architecture/cognitive-product-architecture.md`
- `docs/reference/runtime.md`
- `docs/reference/context-composer.md`
- `docs/reference/tools.md`
- `docs/reference/artifacts-and-paths.md`
- `docs/reference/events.md`
- `docs/guide/features.md`

## Stable Decisions

The following decisions are now part of the stable contract:

- better models may improve cognitive products without redefining
  authority-bearing state
- narrative memory is a non-authoritative sibling product, not an extension of
  kernel truth and not a subtype of deliberation memory
- repository-native precedent remains explicit and separate; repeated retrieval
  is not precedent promotion
- model assistance is allowed only for bounded narrative extraction and
  ambiguity-gated rerank outside the kernel path
- context admission remains deterministic and model-free
- injected narrative recall carries provenance and freshness cues and reminds
  the model to verify before applying recalled guidance

## Remaining Backlog

The following items remain intentionally outside the current stable contract:

- sharing the semantic rerank oracle with repository-native precedent retrieval
- revisiting the ambiguity gate metric if retrieval scale or corpus density
  changes materially
- introducing a reviewed narrative-file destination beyond explicit promotion
  into the current agent self-bundle workflow

## Archive Notes

- Historical option analysis, open questions, and pre-promotion proposal detail
  were intentionally removed from this file after promotion.
- Future changes to narrative-memory authority boundaries, precedent-routing
  semantics, or semantic-oracle scope should start from a new focused research
  note rather than reopening this promoted pointer.
