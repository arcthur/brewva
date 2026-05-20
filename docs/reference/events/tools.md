# Tool Event Families

This page covers tool execution, verification, mutation, rollback, read-path,
and tool-output events.

## Tool Execution

Tool execution events record start, end, blocked calls, marked calls, and
attempt-level binding or contract warnings. They provide an audit trail for
how a managed tool moved through policy, execution, and result recording.

The durable tool result event is the replay-visible outcome. Start/end events
explain lifecycle and timing.

## Verification

Verification events record writes that require verification, verification
outcomes, and verification state resets. Verification reports remain the
operator-facing summary; events are the evidence behind that summary.

Ordinary verifier blockers are verification debt. They should be surfaced and
repaired, but they do not become hard task blockers unless a specific authority
surface promotes them.

## Mutation And Rollback

Patch, reversible mutation, rollback, and redo events connect an effectful tool
call to its receipt, recovery preparation, and commitment posture.

Commitment posture has two orthogonal axes:

- recoverability: `observe_only`, `reversible`, `compensatable`,
  `manual_recovery`, or `irreversible`
- visibility: `local_only`, `workspace_visible`, `externally_observable`, or
  `credential_sensitive`

`externally_observable` is visibility, not recoverability. A send-like tool can
therefore be `manual_recovery` and `externally_observable` at the same time.

Read these events with the tool authority decision:

- `workspace_patchset` preparation means the runtime captured a patchset anchor
  before execution; exact reversibility is only proven by the later mutation
  receipt and rollback handle
- rollback events apply only to recorded patch or mutation sets
- redo events restore a previously rolled-back mutation branch

## Read Path And Output

Read-path discovery, output observation, output distillation, artifact
persistence, and output search events are inspection support. They help explain
what was read, what output was retained, and how the runtime compressed noisy
tool output.

Repository-scoped retrieval filters repository artifacts to the current task
target roots. Browser outputs remain workspace-root scoped.

## Implementation Anchors

- `packages/brewva-runtime/src/runtime/kernel/kernel.ts`
- `packages/brewva-runtime/src/runtime/kernel/kernel.ts`
- `packages/brewva-runtime/src/runtime/kernel/kernel.ts`
- `packages/brewva-runtime/src/runtime/kernel/kernel.ts`
- `packages/brewva-runtime/src/runtime/kernel/kernel.ts`
