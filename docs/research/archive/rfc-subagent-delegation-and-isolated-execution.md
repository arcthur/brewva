# Research: Subagent Delegation and Isolated Execution

## Document Metadata

- Status: `archived`
- Owner: runtime maintainers
- Last reviewed: `2026-04-06`
- Promotion target:
  - `docs/architecture/system-architecture.md`
  - `docs/architecture/cognitive-product-architecture.md`
  - `docs/reference/runtime.md`
  - `docs/reference/tools.md`
  - `docs/reference/events.md`
  - `docs/reference/skills.md`
  - `docs/journeys/operator/background-and-parallelism.md`

## Archive Summary

This note is archived as Brewva's first delegation-phase design record.

It described the original isolated child-run model when execution was centered
on `subagent profile`. That contract is no longer current, but this file is
still useful as the starting point of Brewva's delegation lineage.

## What This RFC Contributed

The durable first-phase ideas were:

- child runs should be isolated from the parent context window
- child authority should only narrow from the parent
- parent-controlled adoption remains the only write merge path
- child lifecycle and recovery need durable records rather than process-local
  state
- delegation belongs in the hosted and deliberation control plane, not in a new
  kernel authority object

## What Changed Later

This archive note used `subagent profile` as the main execution abstraction.
That was later replaced by the cleaner stable split:

- `SkillContract`
- `ExecutionEnvelope`
- `AgentSpec`
- `HostedDelegationTarget`

Delegated result kinds also moved forward to `exploration`, `plan`, `review`,
`qa`, and `patch`, while `runtime.verification.*` remained separate kernel
authority.

## Read These Instead

- `docs/architecture/system-architecture.md`
- `docs/architecture/cognitive-product-architecture.md`
- `docs/reference/runtime.md`
- `docs/reference/tools.md`
- `docs/reference/events.md`
- `docs/reference/skills.md`
- `docs/journeys/operator/background-and-parallelism.md`
- `docs/research/archive/rfc-skill-first-delegation-and-execution-envelopes.md`

## Why Keep This File

Keep this note only as the first delegation milestone in the archive chain:

- it explains where the original isolation model came from
- it helps compare the old profile-based phase with the later skill-first
  contract
- it preserves the initial rationale for durable child-run lifecycle records

For detailed phase-one design text, use git history instead of restoring the
previous long-form RFC body.
