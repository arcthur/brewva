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
call to its receipt and recovery posture.

Read these events with the tool authority decision:

- rollbackable effects must produce a receipt or explicit non-rollbackable
  reason
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

- `packages/brewva-runtime/src/domain/tools/tool-gate.ts`
- `packages/brewva-runtime/src/domain/tools/tool-invocation-spine.ts`
- `packages/brewva-runtime/src/domain/verification/verification.ts`
- `packages/brewva-runtime/src/domain/governance/reversible-mutation.ts`
- `packages/brewva-runtime/src/domain/context/tool-output-distilled.ts`
