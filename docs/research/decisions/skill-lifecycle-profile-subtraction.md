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
- Hosted turns now render the available SkillCard catalog and leave semantic matching to the model.
- Optional deep search lives in `discover_skills`, backed by shared `@brewva/brewva-search` ranking.

## Superseded by

- `docs/research/decisions/model-operated-working-memory-and-context-governance-reset.md`
- `docs/research/decisions/capability-selection-and-authority-isolation.md`
- `docs/research/decisions/advisory-skill-selection-and-cross-root-box-execution.md`
