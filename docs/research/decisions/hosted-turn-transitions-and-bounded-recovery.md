# Decision: Hosted Turn Transitions and Bounded Recovery

## Metadata

- Decision: `session_turn_transition` is the rebuildable hosted-flow contract for continuation, interruption, delegation wait states, approval wait states, and bounded recovery posture
- Date: `2026-04-03`
- Status: accepted
- Stable docs:
  - `docs/architecture/system-architecture.md`
  - `docs/architecture/exploration-and-effect-governance.md`
  - `docs/architecture/invariants-and-reliability.md`
  - `docs/reference/runtime.md`
  - `docs/reference/events/README.md`
  - `docs/journeys/internal/context-and-compaction.md`
- Code anchors:
  - `packages/brewva-gateway/src/session/turn-transition.ts`

## Decision Summary

- `session_turn_transition` is the rebuildable hosted-flow contract for continuation, interruption, delegation wait states, approval wait states, and bounded recovery posture
- hosted recovery remains an experience-ring control-plane concern; it does not authorize effects, approvals, rollback, or replay truth
- hosted execution uses an explicit bounded recovery ladder for compaction, provider fallback, output-budget escalation, interruption, WAL resume, and reasoning-revert resume
- The accepted decision is:
- `session_turn_transition` is the rebuildable hosted-flow contract for continuation, interruption, delegation wait states, approval wait states, and bounded recovery posture.
- Hosted recovery remains an experience-ring control-plane concern; it does not authorize effects, approvals, rollback, or replay truth.
- Hosted execution uses an explicit bounded recovery ladder for compaction, provider fallback, output-budget escalation, interruption, WAL resume, and reasoning-revert resume.

## Superseded by

- None.
