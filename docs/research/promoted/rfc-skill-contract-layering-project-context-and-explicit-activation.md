# Research: Skill Contract Layering, Project Context, And Explicit Activation

## Document Metadata

- Status: `promoted`
- Owner: runtime and gateway maintainers
- Last reviewed: `2026-04-10`
- Promotion target:
  - `docs/architecture/system-architecture.md`
  - `docs/reference/skills.md`
  - `docs/reference/runtime.md`
  - `docs/reference/runtime-plugins.md`
  - `docs/reference/tools.md`

## Promotion Summary

This note is now a promoted status pointer.

The accepted decision is:

- Brewva keeps skills as semantic runtime contracts rather than regressing to
  prompt-only instruction fragments
- semantic validation moves into a runtime-owned validation subsystem instead
  of remaining inlined inside `SkillLifecycleService`
- preview validation and authoritative completion share one closed validator
  composition, and commit rebuilds fresh post-verification evidence inside
  runtime
- `SKILL.md` remains the only runtime-authoritative authored skill contract
  file
- project-local conventions continue to live in `skills/project/shared/*.md`
  and `skills/project/overlays/<skill>/SKILL.md`; Brewva does not introduce a
  second authored `.brewva/rules` plane
- hosted recommendation and pre-skill narrowing may strengthen the next
  semantic action toward `skill_load`, but activation itself remains explicit
  and automatic activation stays out of the contract

## Stable References

- `docs/architecture/system-architecture.md`
- `docs/reference/skills.md`
- `docs/reference/runtime.md`
- `docs/reference/runtime-plugins.md`
- `docs/reference/tools.md`

## Stable Contract Summary

The promoted contract is:

1. `authority.skills.complete(...)` remains the authoritative skill commit
   boundary, and `inspect.skills.validateOutputs(...)` remains the preview
   surface for the same runtime-owned validator composition.
2. Runtime owns evidence freshness. Callers pass raw outputs only; commit
   rebuilds validation context from the latest event tape / read-model state
   after verification.
3. Semantic-bound validation is mandatory runtime behavior for semantic-bound
   skills. It is not a hosted plugin and not a config-injected extension point.
4. `SkillLifecycleService` owns lifecycle state, receipts, task-spec promotion,
   repair posture, and budget gating; validator implementations and evidence
   derivation live outside that service.
5. `skills/project/shared/*.md` and project overlays remain the project
   convention plane. They can supplement context or tighten skill contracts,
   but they do not grant new tool authority or introduce a second authored
   rules catalog.
6. Hosted routing, recommendations, and pre-skill narrowing remain control-plane
   behavior only. They can surface `skill_load`-first posture, but they do not
   create implicit activation or a second runtime-owned planning loop.
7. Skill validation and completion fail closed when no active skill is loaded.

## Validation Status

Promotion is backed by:

- runtime validation subsystem coverage for contract + semantic validator
  composition, evidence freshness rebuilding, and fail-fast builder assembly
- runtime contract coverage showing preview and commit share the same validator
  composition while commit sees fresh post-verification evidence
- internal entrypoint coverage that keeps validation assembly primitives
  runtime-owned instead of reopening an internal composition seam
- tool contract coverage showing `skill_complete` preserves the preview ->
  verification -> commit posture, fails closed without an active skill, and
  uses the same verification-evidence semantics as runtime-owned validation for
  review synthesis
- stable documentation updates in runtime, skills, runtime-plugins, tools, and
  system-architecture docs that keep explicit activation, shared project
  context, and no-second-rules-plane boundaries visible

## Remaining Backlog

The following items are intentionally deferred and are not part of the promoted
contract:

- selector frontmatter for shared project context
- path-aware hosted refresh receipts beyond the current explicit recommendation
  posture
- broader evidence-helper reuse outside the current runtime validation and
  review-synthesis paths
- any `.brewva/rules` catalog, automatic skill activation, or new public
  `runtime.inspect.rules.*` family

If future work changes those boundaries, it should start from a new focused RFC
rather than reopening this promoted pointer.

## Historical Notes

- Historical option analysis and incubation-stage rollout notes were removed
  from this file after promotion.
- The stable contract now lives in architecture/reference docs, runtime code,
  and regression tests rather than in `docs/research/`.
