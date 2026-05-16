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
  - `packages/brewva-runtime/src/domain/skills/profiles.ts`
  - `packages/brewva-gateway/src/hosted/internal/session/skill-first.ts`
  - `packages/brewva-tools/src/families/workflow/skill-load.ts`
  - `test/contract/runtime/skill-lifecycle-profiles.contract.test.ts`
  - `test/contract/extensions/skill-routing-eval.contract.test.ts`
  - `test/contract/runtime/skill-document-parsing.contract.test.ts`
  - `test/contract/runtime/skills-discovery.contract.test.ts`
  - `test/contract/tools/tools-skill-complete.contract.test.ts`

## Decision Summary

- Discovery answers who exists. It supports catalog and inspect surfaces, not hit-rate scoring.
- Selection answers whether a skill should be chosen. It has separate `forScorer` and `forModel` views over the same approved source fields.
- Activation answers what the model should see after explicit `skill_load`. It carries effect posture, budget summary, required outputs, required and missing inputs, bounded consumed outputs, relevant normalization issues, and effective instructions.
- Handoff answers whether a shortlisted candidate is `blocked`, `available`, or `ready` now. It can require inputs or allow an actionable shortlisted candidate to proceed, but it cannot score cold-start selection.
- The default hit-rate rule is code-owned: no field affects hit rate unless it belongs to the selection projection.

## Superseded by

- `docs/research/decisions/model-operated-working-memory-and-context-governance-reset.md`
- `docs/research/decisions/capability-selection-and-authority-isolation.md`
