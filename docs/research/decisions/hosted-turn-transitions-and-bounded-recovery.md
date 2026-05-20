# Decision: Hosted Turn Transitions and Bounded Recovery

## Metadata

- Decision: hosted transition receipts were the rebuildable hosted-flow contract for continuation, interruption, delegation wait states, approval wait states, and bounded recovery posture
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
  - Removed by the four-port runtime cutover.

## Decision Summary

- Hosted transition receipts were the rebuildable hosted-flow contract for continuation, interruption, delegation wait states, approval wait states, and bounded recovery posture
- hosted recovery remains an experience-ring control-plane concern; it does not authorize effects, approvals, rollback, or replay truth
- hosted execution uses an explicit bounded recovery ladder for compaction, provider fallback, output-budget escalation, interruption, WAL resume, and reasoning-revert resume
- The accepted decision is:
- Hosted transition receipts were the rebuildable hosted-flow contract for continuation, interruption, delegation wait states, approval wait states, and bounded recovery posture.
- Hosted recovery remains an experience-ring control-plane concern; it does not authorize effects, approvals, rollback, or replay truth.
- Hosted execution uses an explicit bounded recovery ladder for compaction, provider fallback, output-budget escalation, interruption, WAL resume, and reasoning-revert resume.

## Superseded by

- `docs/research/decisions/four-port-runtime-simplification-rfc.md`
