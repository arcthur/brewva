# Decision: Skill Metadata As Runtime Contract And Routing Substrate

## Metadata

- Decision: `description` and the markdown body remain descriptive model/operator guidance.
- Date: `2026-04-19`
- Status: accepted
- Stable docs:
  - `docs/reference/skills.md`
  - `docs/reference/skill-routing.md`
  - `docs/reference/tools.md`
  - `docs/architecture/system-architecture.md`
- Code anchors:
  - `test/contract/runtime/skill-readiness.contract.test.ts`
  - `test/contract/tools/workflow-status.contract.test.ts`
  - `test/contract/tools/tools-skill-complete.contract.test.ts`
  - `test/contract/runtime/skill-document-parsing.contract.test.ts`
  - `test/contract/runtime/skill-creator-quick-validate.contract.test.ts`

## Decision Summary

- `description` and the markdown body remain descriptive model/operator guidance.
- `selection.*` feeds cold-start skill-first recommendation.
- `requires` and `consumes` feed runtime skill readiness, consumed-output materialization, `skill_load`, `workflow_status`, and skill-routing context.
- `composable_with` gates concurrent activation. Either the active skill or the requested skill may declare the other composable.
- `effects.*`, `resources.*`, and `intent.*` remain contract metadata for authority, budget, completion, and normalized artifact consumers.

## Superseded by

- `docs/research/decisions/model-operated-working-memory-and-context-governance-reset.md`
- `docs/research/decisions/capability-selection-and-authority-isolation.md`
