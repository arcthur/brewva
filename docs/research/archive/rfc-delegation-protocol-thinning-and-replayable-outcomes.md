# Research: Delegation Protocol Thinning and Replayable Outcomes

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
  - `docs/journeys/operator/background-and-parallelism.md`

## Archive Summary

This note is archived as an intermediate delegation-transition record.

It captured the step between Brewva's first `subagent profile` model and the
later skill-first delegation contract. The lasting lesson was architectural,
not syntactic:

`kernel governs effects, receipts, and replay; deliberation governs delegation and path-finding`

That split survived. Most of the transitional request and packet shapes in this
draft did not.

## What This RFC Contributed

The durable ideas that carried forward were:

- delegation should become more typed and replay-friendly rather than more
  prompt-heavy
- parent-facing handoff for background and late child outcomes should be
  durable and inspectable
- long-running delegated work needs explicit completion semantics
- the kernel should not absorb planner-shaped delegation intelligence

## What Superseded It

The final public delegation contract moved beyond this document:

- `SkillContract` owns semantic work meaning
- `ExecutionEnvelope` owns execution posture and isolation
- `AgentSpec` composes skill plus envelope into a named delegated worker shape
- `HostedDelegationTarget` is the runtime materialization of one delegated run
- delegated result kinds settled on `exploration`, `plan`, `review`, `qa`, and
  `patch`

This archive note remains useful only as the bridge between the earlier
profile-based phase and the later skill-first phase.

## Read These Instead

- `docs/reference/runtime.md`
- `docs/reference/tools.md`
- `docs/reference/events.md`
- `docs/journeys/operator/background-and-parallelism.md`
- `docs/research/archive/rfc-skill-first-delegation-and-execution-envelopes.md`

## Related Historical Notes

- `docs/research/archive/rfc-subagent-delegation-and-isolated-execution.md`
- `docs/research/archive/rfc-skill-first-delegation-and-execution-envelopes.md`

## Why Keep This File

Keep this note only for delegation archaeology:

- understanding why replayable outcome handoff became explicit
- tracing how Brewva moved away from profile-heavy delegation presets
- explaining why the kernel did not become a delegation planner

For full historical detail, use git history rather than expanding this archive
summary back into a long RFC.
