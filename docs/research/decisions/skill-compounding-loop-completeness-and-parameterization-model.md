# Decision: Skill Compounding Loop Completeness and Parameterization Model

## Metadata

- Decision: `docs/solutions/**` is the canonical repository-native precedent layer, and systemic `retro` / `ship` findings hand off to `knowledge_capture` as a separate step instead of violating `workspace_write` boundaries.
- Date: `2026-04-16`
- Status: accepted
- Stable docs:
  - `docs/reference/skills.md`
  - `docs/reference/configuration.md`
  - `docs/reference/events/README.md`
  - `docs/solutions/README.md`
- Code anchors:
  - `packages/brewva-gateway/src/daemon/gateway-daemon.ts`
  - `packages/brewva-gateway/src/daemon/schedule-runner.ts`
  - `packages/brewva-gateway/src/session/schedule-trigger.ts`

## Decision Summary

- `docs/solutions/**` is the canonical repository-native precedent layer, and systemic `retro` / `ship` findings hand off to `knowledge_capture` as a separate step instead of violating `workspace_write` boundaries.
- `schedule.selfImprove` is the stable policy surface for autonomous self-improve scheduling. The gateway daemon seeds or reconciles the durable recurring intent and its parent session idempotently.
- Scheduled continuity may carry the parent TaskSpec, truth context, anchor, and active skill into the child run. If inherited skill activation fails, the runtime records `schedule_trigger_apply_warning` so the degradation is inspectable rather than silent.
- `self-improve` promotion evidence must remain repeat-backed. A single occurrence is insufficient to derive a promotion draft.
- TaskSpec remains the machine-readable invocation surface for reusable skills: `goal`, `expectedBehavior`, `constraints`, and explicit targets are the accepted way to parameterize the subject of a skill run.

## Superseded by

- `docs/research/decisions/model-operated-working-memory-and-context-governance-reset.md`
