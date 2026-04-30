# Research: Skill Metadata As Runtime Contract And Routing Substrate

## Document Metadata

- Status: `promoted`
- Owner: runtime and gateway maintainers
- Last reviewed: `2026-04-19`
- Promotion target:
  - `docs/reference/skills.md`
  - `docs/reference/skill-routing.md`
  - `docs/reference/tools.md`
  - `docs/architecture/system-architecture.md`

## Promotion Summary

This note is now a promoted status pointer.

The accepted decision is:

- structured skill metadata is retained only when a runtime, control-plane, or
  operator surface consumes it
- `composable_with` is strong runtime metadata because
  `SkillLifecycleService` uses it as the concurrent activation gate
- `requires` and `consumes` are strong artifact-flow metadata because runtime
  readiness classifies skills as `blocked`, `available`, or `ready`
- `workflow_status`, `skill_load`, and
  `runtime.inspect.skills.getReadiness(...)` expose structured readiness
- missing `requires` renders blocked readiness but does not hard-block
  `skill_load`
- `execution_hints.suggested_chains` was removed; unsupported workflow
  guidance belongs in skill markdown unless a runtime consumer exists

Stable references:

- `docs/reference/skills.md`
- `docs/reference/skill-routing.md`
- `docs/reference/tools.md`
- `docs/architecture/exploration-and-effect-governance.md`

## Stable Contract Summary

1. `description` and the markdown body remain descriptive model/operator
   guidance.
2. `selection.*` feeds cold-start skill-first recommendation.
3. `requires` and `consumes` feed runtime skill readiness, consumed-output
   materialization, `skill_load`, `workflow_status`, and skill-routing context.
4. `composable_with` gates concurrent activation. Either the active skill or
   the requested skill may declare the other composable.
5. `effects.*`, `resources.*`, and `intent.*` remain contract metadata for
   authority, budget, completion, and normalized artifact consumers.
6. `execution_hints.preferred_tools` and `execution_hints.fallback_tools`
   remain structured metadata because skill index generation, gateway subagent
   orchestration, and gateway tool-surface narrowing consume them. The later
   promoted lifecycle-profile subtraction removed them from default
   `skill_load` rendering. `execution_hints.cost_hint` remains advisory
   surfaced metadata until a runtime budget or scheduler consumer makes it
   behaviorally active.

## Validation Status

Promotion is backed by:

- runtime contract coverage for skill readiness classification and scoring
- lifecycle contract coverage proving `composable_with` changes activation
  behavior
- tool contract coverage proving `workflow_status` and `skill_load` surface
  readiness without turning missing `requires` into a load rejection
- parser and authoring-validator coverage proving `suggested_chains` is no
  longer accepted as structured frontmatter

Representative anchors:

- `test/contract/runtime/skill-readiness.contract.test.ts`
- `test/contract/tools/workflow-status.contract.test.ts`
- `test/contract/tools/tools-skill-complete.contract.test.ts`
- `test/contract/runtime/skill-document-parsing.contract.test.ts`
- `test/contract/runtime/skill-creator-quick-validate.contract.test.ts`

## Historical Notes

- The active RFC compared Brewva's richer metadata model with prompt-first
  skill systems and resolved the core question by separating model-readable
  prose from runtime-consumed contract metadata.
- The stable contract now lives in reference docs, runtime inspect surfaces,
  tool rendering, and regression tests rather than in `docs/research/`.
