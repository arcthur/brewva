# Decision: Skill Contract Layering, Project Context, And Explicit Activation

## Metadata

- Decision: `authority.skills.complete(...)` remains the authoritative skill commit boundary, and `inspect.skills.validateOutputs(...)` remains the preview surface for the same runtime-owned validator composition.
- Date: `2026-04-10`
- Status: accepted
- Stable docs:
  - `docs/architecture/system-architecture.md`
  - `docs/reference/skills.md`
  - `docs/reference/runtime.md`
  - `docs/reference/extensions.md`
  - `docs/reference/tools.md`
- Code anchors:
  - `N/A`

## Decision Summary

- `authority.skills.complete(...)` remains the authoritative skill commit boundary, and `inspect.skills.validateOutputs(...)` remains the preview surface for the same runtime-owned validator composition.
- Runtime owns evidence freshness. Callers pass raw outputs only; commit rebuilds validation context from the latest event tape / read-model state after verification.
- Semantic-bound validation is mandatory runtime behavior for semantic-bound skills. It is not a hosted plugin and not a config-injected extension point.
- `SkillLifecycleService` owns lifecycle state, receipts, task-spec promotion, repair posture, and budget gating; validator implementations and evidence derivation live outside that service.
- `skills/project/shared/*.md` and project overlays remain the project convention plane. They can supplement context or tighten skill contracts, but they do not grant new tool authority or introduce a second authored rules catalog.

## Superseded by

- `docs/research/decisions/model-operated-working-memory-and-context-governance-reset.md`
