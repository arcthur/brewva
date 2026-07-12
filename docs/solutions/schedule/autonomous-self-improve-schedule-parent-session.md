---
id: sol-2026-04-15-autonomous-self-improve-schedule-parent-session
title: Autonomous self-improve schedule preserves parent task and advisory context
status: active
problem_kind: design
module: brewva-gateway
boundaries:
  - gateway.daemon.scheduler
  - HostedRuntimeAdapterPort.ops.skills
  - HostedRuntimeAdapterPort.ops.schedule
source_artifacts:
  - design_spec
  - retro_findings
  - verification_evidence
tags:
  - schedule
  - self-improve
  - advisory-continuity
  - task-spec
updated_at: 2026-05-16
---

## Context

The repository wanted an autonomous `self-improve` loop that was native to the
existing scheduler, session, and advisory context model rather than a prompt-side cron
hack. The immediate temptation was to seed a recurring schedule intent whose
reason text merely told the child session to "run self-improve".

## Guidance

Do not treat recurring `self-improve` as a raw cron prompt. Seed a fixed parent
session that owns:

- the `self-improve` advisory context
- the TaskSpec goal / expected behavior / constraints for the learning pass
- the durable recurring schedule intent

Then make inherited schedule continuity carry the parent session's advisory
context alongside TaskSpec, truth facts, and tape continuation anchor context into the
child run.

## Why This Matters

If the schedule only passes freeform reason text, the child run has to rediscover
the intended semantic artifacts from prose. That weakens continuation fidelity
and makes the automation look like a second hidden control path.

By contrast, parent-session seeding keeps the autonomous loop inside Brewva's
existing semantic contract:

- TaskSpec remains the parameter surface
- the parent session's advisory context describes the expected artifacts
- capability selection remains separate from the schedule trigger
- scheduler remains the recurring trigger, not the policy brain
- `self-improve` still stops at promotion candidates rather than direct writes

## Approval Posture (`schedule.selfImprove.approvalMode`)

Scheduled workers have no interactive approver, so an effectful tool (`exec`)
would suspend the run. `approvalMode` controls that hop:

- `"auto_within_envelope"` (default for the config-authored lane): the worker
  auto-approves its own effectful tools inside its governed effect boundary and
  resumes, mirroring the delegated-child envelope. Every decision is recorded
  (actor `schedule-envelope`) so the auto-approval stays auditable.
- `"suspend"`: keep the interactive approval hop (set explicitly to opt out).
  An unrecognized explicit value also fails CLOSED to `"suspend"` — garbage
  never grants the envelope.

Authorization comes from an unforgeable PROVENANCE stamp, never from intent
records: the daemon grants the envelope only to an intent carrying
`origin: "config_policy"` (stamped by the daemon's own reconcile path), and whose
`intentId` and `parentSessionId` also match the config-authored
`schedule.selfImprove` entry with the mode explicitly set. The `origin` check
comes first, so a model that mints a colliding `intentId` cannot forge the
envelope. Intents minted by the model-facing `schedule_intent` / `follow_up` tools
always run with `"suspend"`, whatever fields their records carry — a model must
never be able to schedule itself a future auto-approved session.

## Default Lane: The Calibration-Report Pass

The calibration-report pass IS the default `schedule.selfImprove` lane: with a
running gateway daemon and default config, a weekly worker follows the
`calibration-report` skill and writes report artifacts plus promotion
candidates — nothing else. Opt out with `schedule.selfImprove.enabled: false`
(or disable the scheduler entirely; an unavailable scheduler disarms the lane
with a warning instead of failing daemon startup). The block below shows the
shape for customizing cadence, task, or approval posture:

```jsonc
{
  "schedule": {
    "selfImprove": {
      "enabled": true, // ON by default; set false to opt out
      "parentSessionId": "self-improve-parent",
      "intentId": "calibration-report-weekly",
      "reason": "weekly harness calibration report",
      "goalRef": "calibration-report",
      "continuityMode": "inherit",
      "cron": "0 6 * * 1",
      "maxRuns": 52,
      "approvalMode": "auto_within_envelope",
      "taskSpec": {
        "goal": "Follow the calibration-report skill: aggregate advisory receipts, run the offline evals, and write the dated report with proposals for human review.",
        "constraints": ["Report artifacts only; never change rules, config, or schedules."],
      },
    },
  },
}
```

The goal text names the `calibration-report` skill, so skill selection renders
it on the wakeup turn (explicit mention) and the tools its document instructs
surface automatically for that turn. Reports land under
`.brewva/reports/calibration/` for human review; promotion of any proposal
stays a reviewed code change.

## When to Apply

Use this pattern when a recurring scheduled pass is supposed to keep the same
semantic specialist and task posture across runs, especially for repository
maintenance, retrospection, or evidence-gated improvement work.

## Examples

- recurring `self-improve` seeded from `schedule.selfImprove`
- future recurring specialist policies that should inherit stable advisory
  context and TaskSpec instead of relying on prompt prose

## References

- `docs/research/decisions/skill-compounding-loop-completeness-and-parameterization-model.md`
- `packages/brewva-gateway/src/daemon/schedule-runner.ts`
- `packages/brewva-gateway/src/hosted/internal/turn/schedule-trigger.ts`
- `packages/brewva-gateway/src/daemon/gateway-daemon.ts`
