# Worker Event Families

This page covers schedule, subagent, worker-result, workflow-derived, model
selection, and channel orchestration event families.

## Schedule

Schedule events record intent recovery, wakeups, trigger warnings, and child
session lifecycle. Schedule intent state lives in the schedule projection and
runtime authority surface; events explain why a scheduled execution ran,
failed, or deferred.

## Subagents

Subagent events record spawn, running, completion, failure, cancellation,
outcome parse failures, and surfaced delivery. They are control-plane evidence
for delegated work.

Subagent execution is not a distributed transaction coordinator. There is no
cross-agent saga behavior or automatic partial-failure repair; parent adoption
remains explicit through worker-result merge and apply surfaces.

## Worker Results

Worker result events record when patch-producing child outputs are applied or
fail to apply. They are parent-owned adoption events, not child-owned mutation
authority.

## Workflow-Derived Surfaces

Workflow-derived events expose derived artifacts, status changes, model preset
selection, and hosted delivery surfaces. They are useful for operator
inspection and UI rendering, but derived artifacts can be rebuilt from stronger
inputs where the family is marked rebuildable.

## Implementation Anchors

- `packages/brewva-gateway/src/daemon/schedule-runner.ts`
- `packages/brewva-runtime/src/protocol.ts`
- `packages/brewva-runtime/src/protocol.ts`
- `packages/brewva-gateway/src/delegation`
