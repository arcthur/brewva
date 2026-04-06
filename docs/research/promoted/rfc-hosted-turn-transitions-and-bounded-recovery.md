# Research: Hosted Turn Transitions and Bounded Recovery

## Document Metadata

- Status: `promoted`
- Owner: gateway and runtime maintainers
- Last reviewed: `2026-04-03`
- Promotion target:
  - `docs/architecture/system-architecture.md`
  - `docs/architecture/exploration-and-effect-governance.md`
  - `docs/architecture/invariants-and-reliability.md`
  - `docs/reference/runtime.md`
  - `docs/reference/events.md`
  - `docs/journeys/internal/context-and-compaction.md`

## Promotion Summary

This note is now a promoted status pointer.

The accepted decision is:

- `session_turn_transition` is the rebuildable hosted-flow contract for
  continuation, interruption, delegation wait states, approval wait states, and
  bounded recovery posture
- hosted recovery remains an experience-ring control-plane concern; it does not
  authorize effects, approvals, rollback, or replay truth
- hosted execution uses an explicit bounded recovery ladder for compaction,
  provider fallback, output-budget escalation, interruption, WAL resume, and
  reasoning-revert resume

## Stable References

- `docs/architecture/system-architecture.md`
- `docs/architecture/exploration-and-effect-governance.md`
- `docs/architecture/invariants-and-reliability.md`
- `docs/reference/runtime.md`
- `docs/reference/events.md`
- `docs/journeys/internal/context-and-compaction.md`

## Current Implementation Notes

- `packages/brewva-gateway/src/session/turn-transition.ts` defines the stable
  `TurnTransitionReason` set and transition-family mapping.
- `docs/reference/events.md` treats `session_turn_transition` as the rebuildable
  hosted-flow grammar rather than a kernel truth surface.
- `docs/architecture/system-architecture.md` and
  `docs/journeys/internal/context-and-compaction.md` describe the operator and
  recovery semantics around `reasoning_revert_resume`, interrupt handling, and
  hosted continuation.

## Remaining Backlog

- Any new hosted continuation family or materially different recovery contract
  should start from a new focused RFC instead of widening this promoted pointer
  back into a rollout plan.
