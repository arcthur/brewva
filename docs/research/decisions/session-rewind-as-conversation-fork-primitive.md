# Decision: Session Rewind As A Conversation-Fork Primitive

## Metadata

- Decision: One transaction engine owns rewind state. `SessionRewindService` remains the only writer for session rewind checkpoints, rewind completions, redo completions, and redo-stack supersession.
- Date: `2026-04-28`
- Status: accepted
- Stable docs:
  - `docs/architecture/control-and-data-flow.md`
  - `docs/architecture/invariants-and-reliability.md`
  - `docs/reference/runtime.md`
  - `docs/reference/events/README.md`
  - `docs/reference/session-lifecycle.md`
  - `docs/journeys/operator/inspect-replay-and-recovery.md`
  - `docs/guide/cli.md`
- Code anchors:
  - `packages/brewva-runtime/src/services/session-rewind.ts`
  - `packages/brewva-runtime/src/projection/session-rewind.ts`
  - `packages/brewva-runtime/src/runtime-method-groups.ts`
  - `packages/brewva-runtime/src/governance/action-policy.ts`
  - `packages/brewva-runtime/src/events/event-types.ts`
  - `packages/brewva-runtime/src/contracts/session.ts`
  - `packages/brewva-session-index/src/index.ts`
  - `packages/brewva-cli/src/shell/flows/session-workflow.ts`

## Decision Summary

- One transaction engine owns rewind state. `SessionRewindService` remains the only writer for session rewind checkpoints, rewind completions, redo completions, and redo-stack supersession.
- Active lineage is authoritative. Rewind targets and patch rollback scope are computed from the active reasoning lineage. Patch events from abandoned branches do not participate in later rollback windows.
- Tape stores references, not embedded branch records. Session rewind events carry receipt ids and event ids. The reasoning tape remains the source of truth for reasoning records.
- Runtime APIs are guarded while turns are active. Rewind and redo reject non-idle sessions before mutating reasoning or workspace state.
- Governance is mode-aware and fail-closed. Conversation-only rewind requires the session/control mutation policy. Code and full rewind require both session/control mutation and workspace write effects.

## Superseded by

- None.
