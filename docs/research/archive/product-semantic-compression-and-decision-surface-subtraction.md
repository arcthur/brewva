# Archived Research: Product Semantic Compression And Decision Surface Subtraction

## Document Metadata

- Status: `archived`
- Owner: product and runtime maintainers
- Last reviewed: `2026-05-08`
- Promotion target:
  - `docs/research/decisions/model-operated-working-memory-and-context-governance-reset.md`
  - `docs/architecture/cognitive-product-architecture.md`
  - `docs/reference/skill-routing.md`
  - `docs/reference/hosted-dynamic-context.md`
- Archived on: `2026-05-08`
- Superseded by:
  - `docs/research/decisions/model-operated-working-memory-and-context-governance-reset.md`
  - `docs/architecture/cognitive-product-architecture.md`
  - `docs/reference/skill-routing.md`
  - `docs/reference/hosted-dynamic-context.md`

## Archive Summary

This note explored reducing product-facing decision surfaces around task, skill,
search, evidence, and finish labels.

It is archived because the model-operated working-memory reset changed the
underlying premise:

- skills are readable files, not hosted runtime gates
- `skill_load` is not part of the default hosted path
- `skill_completed` is not a protected default-path producer surface
- context-source admission descriptors have been removed from the default path
- recall is on demand rather than a hidden per-turn admission source

The still-valid direction is surface subtraction: do not add hidden planners,
stage machines, or routing labels to make the default path feel simpler.

The superseding contract is:

`Model owns attention. Kernel owns consequence. Tape owns truth. Runtime owns physics.`

Read current stable docs and code first. Use this archived note only for design
archaeology around why product vocabulary had to shrink.
