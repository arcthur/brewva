# Research: Skill-First Delegation and Execution Envelopes

## Document Metadata

- Status: `archived`
- Owner: runtime maintainers
- Last reviewed: `2026-04-06`
- Promotion target:
  - `docs/architecture/system-architecture.md`
  - `docs/reference/skills.md`
  - `docs/reference/tools.md`
  - `docs/reference/runtime.md`
  - `docs/journeys/operator/background-and-parallelism.md`

## Archive Summary

This note is archived as the delegation-envelope cutover record.

It captured the migration away from `subagent profile`-centered delegation
toward the final split between semantic work contracts and execution posture.
The accepted shape is now stable and documented elsewhere.

## What This RFC Contributed

The durable decisions that carried forward were:

- `SkillContract` defines what delegated work means
- `ExecutionEnvelope` defines how delegated work runs
- `AgentSpec` composes skill plus envelope into a named delegated worker shape
- `HostedDelegationTarget` is the runtime-owned materialization boundary
- semantic ownership stays with skills rather than moving into execution
  profiles

## What Did Not Carry Forward

This draft still discussed compatibility ideas that were later dropped:

- long-lived public aliases for legacy `profile`
- compatibility-heavy preservation of `entrySkill`
- transitional output-shape fields that the final contract removed instead of
  carrying forward indefinitely

The final system chose a harder cutover and cleaner public contract.

## Read These Instead

- `docs/reference/skills.md`
- `docs/reference/tools.md`
- `docs/reference/runtime.md`
- `docs/journeys/operator/background-and-parallelism.md`

## Related Historical Notes

- `docs/research/archive/rfc-subagent-delegation-and-isolated-execution.md`
- `docs/research/archive/rfc-delegation-protocol-thinning-and-replayable-outcomes.md`

## Why Keep This File

Keep this note only to explain why Brewva settled on skill-first delegation and
why `ExecutionEnvelope` / `AgentSpec` exist as separate concepts.

For full migration detail, use git history rather than regrowing this archive
summary into a long transition RFC.
