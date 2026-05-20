# Decision: Skill Lifecycle Profile Subtraction

## Metadata

- Decision: Discovery answers who exists. It supports catalog and inspect surfaces, not hit-rate scoring.
- Date: `2026-04-30`
- Status: accepted
- Stable docs:
  - `docs/reference/skills.md`
  - `docs/reference/skill-routing.md`
  - `docs/reference/extensions.md`
  - `docs/reference/tools.md`
  - `docs/architecture/cognitive-product-architecture.md`
- Code anchors:
  - `packages/brewva-gateway/src/hosted/internal/session/skills/skill-selection.ts`
  - `packages/brewva-tools/src/families/skills/discover-skills.ts`
  - `test/unit/gateway/hosted-behavior/skill-selection.unit.test.ts`

## Decision Summary

- Discovery answers who exists. It supports catalog and inspect surfaces, not hit-rate scoring.
- The former `profiles.ts`, `skill-first`, `skill-load`, and lifecycle-profile tests have since been removed.
- Hosted turns formerly rendered the available SkillCard catalog and left semantic matching to the
  model. The superseding model interface decision replaces that full catalog with a
  deterministic, turn-scoped shortlist.
- Optional deep search lives in `discover_skills`, backed by shared `@brewva/brewva-search` ranking.

## Superseded by

- `docs/research/decisions/model-operated-working-memory-and-context-governance-reset.md`
- `docs/research/decisions/capability-selection-and-authority-isolation.md`
- `docs/research/decisions/advisory-skill-selection-and-cross-root-box-execution.md`
- `docs/research/decisions/model-interface-attention-contract.md`
