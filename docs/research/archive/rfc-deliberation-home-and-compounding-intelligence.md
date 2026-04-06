# Research: Deliberation Home And Compounding Intelligence

## Document Metadata

- Status: `archived`
- Owner: runtime maintainers
- Last reviewed: `2026-04-06`
- Promotion target:
  - `docs/architecture/design-axioms.md`
  - `docs/architecture/cognitive-product-architecture.md`
  - `docs/architecture/system-architecture.md`
  - `docs/reference/runtime.md`
  - `docs/reference/skills.md`
  - `docs/reference/context-composer.md`
  - `docs/reference/tools.md`
  - `docs/journeys/operator/intent-driven-scheduling.md`

## Archive Summary

This note is archived as the rationale record for the deliberation-boundary
reset. The current contracts now live in the stable docs listed above.

The lasting decisions were:

- kernel authority stays narrow
- deliberation artifacts are evidence-backed and non-authoritative
- `@brewva/brewva-deliberation` owns memory and optimization-continuity
  artifacts rather than kernel commitments
- `@brewva/brewva-skill-broker` owns post-execution promotion flow rather than
  turn-time skill brokerage
- optimization remains model-native protocol behavior instead of runtime-owned
  planning authority

## Current Contract

Read current behavior from:

- `docs/architecture/design-axioms.md`
- `docs/architecture/cognitive-product-architecture.md`
- `docs/architecture/system-architecture.md`
- `docs/reference/runtime.md`
- `docs/reference/skills.md`
- `docs/reference/context-composer.md`
- `docs/reference/tools.md`
- `docs/journeys/operator/intent-driven-scheduling.md`

Implemented homes now include:

- `packages/brewva-deliberation/src`
- `packages/brewva-skill-broker/src`
- hosted registration and read-only exposure paths in `packages/brewva-gateway`

## Why Keep This Note

This archive still helps when you need to explain:

- why deliberation memory is separate from tape truth
- why skill promotion is explicit post-execution control-plane behavior
- why optimization continuity is inspectable and advisory rather than hidden
  runtime planning

## Historical Notes

- Detailed landing inventories, promotion checklists, and follow-up ideas were
  removed from the archive-era main file.
- Use git history if you need the original migration detail or implementation
  rollout narrative.
