---
id: sol-2026-04-15-autonomous-self-improve-schedule-parent-session
title: Autonomous self-improve schedule must preserve parent task and active skill
status: active
problem_kind: design
module: brewva-gateway
boundaries:
  - gateway.daemon.scheduler
  - runtime.inspect.skills
  - runtime.authority.schedule
source_artifacts:
  - design_spec
  - retro_findings
  - verification_evidence
tags:
  - schedule
  - self-improve
  - skill-continuity
  - task-spec
updated_at: 2026-04-15
---

## Context

The repository wanted an autonomous `self-improve` loop that was native to the
existing scheduler, session, and skill model rather than a prompt-side cron
hack. The immediate temptation was to seed a recurring schedule intent whose
reason text merely told the child session to "run self-improve".

## Guidance

Do not treat recurring `self-improve` as a raw cron prompt. Seed a fixed parent
session that owns:

- the `self-improve` active skill
- the TaskSpec goal / expected behavior / constraints for the learning pass
- the durable recurring schedule intent

Then make inherited schedule continuity carry the parent session's active skill
alongside TaskSpec, truth facts, and tape handoff context into the child run.

## Why This Matters

If the schedule only passes freeform reason text, the child run has to rediscover
the intended skill contract from prose. That weakens routing fidelity and makes
the automation look like a second hidden control path.

By contrast, parent-session seeding keeps the autonomous loop inside Brewva's
existing semantic contract:

- TaskSpec remains the parameter surface
- active skill state remains the semantic owner
- scheduler remains the recurring trigger, not the policy brain
- `self-improve` still stops at promotion candidates rather than direct writes

## When to Apply

Use this pattern when a recurring scheduled pass is supposed to keep the same
semantic specialist and task posture across runs, especially for repository
maintenance, retrospection, or evidence-gated improvement work.

## Examples

- recurring `self-improve` seeded from `schedule.selfImprove`
- future recurring specialist policies that should inherit a stable active skill
  and TaskSpec instead of relying on prompt prose

## References

- `docs/research/decisions/skill-compounding-loop-completeness-and-parameterization-model.md`
- `packages/brewva-gateway/src/daemon/schedule-runner.ts`
- `packages/brewva-gateway/src/session/schedule-trigger.ts`
- `packages/brewva-gateway/src/daemon/gateway-daemon.ts`
