# Decision: Skill Contract Precision And Advisory Artifact Boundaries

## Metadata

- Decision: Semantic schema ids such as `planning.execution_plan.v2` name normalized consumer-facing views, not exact producer payload shapes.
- Date: `2026-04-17`
- Status: accepted
- Stable docs:
  - `docs/architecture/system-architecture.md`
  - `docs/reference/skills.md`
  - `docs/reference/skill-routing.md`
  - `docs/reference/runtime.md`
  - `docs/reference/tools.md`
  - `docs/reference/extensions.md`
- Code anchors:
  - `test/contract/tools/tools-skill-complete.contract.test.ts`
  - `test/unit/runtime/skill-validation-pipeline.unit.test.ts`
  - `packages/brewva-runtime/src/domain/workflow/artifact-derivation.ts`
  - `packages/brewva-gateway/src/hosted/internal/session/completion-guard.ts`

## Decision Summary

- Semantic schema ids such as `planning.execution_plan.v2` name normalized consumer-facing views, not exact producer payload shapes.
- Producer completion validates required output presence, authored non-semantic `output_contracts`, and Tier A blockers at the boundary where a safe decision is made.
- Tier B fields may remain partial after producer completion, but a named downstream consumer may block until normalization resolves the required fields.
- Tier C fields remain advisory metadata. They may normalize into warnings, degraded summaries, or `unknown` canonical values, but they do not block producer completion or workflow progression.
- Completion guard and repair posture surface unresolved Tier A/B fields, the next blocking consumer, and the minimum contract needed to proceed safely instead of teaching full-schema retry as the only recovery path.

## Superseded by

- `docs/research/decisions/model-operated-working-memory-and-context-governance-reset.md`
