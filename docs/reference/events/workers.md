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

Public inspection derives V2 run-card lifecycle from those events. The public
lifecycle set is `pending`, `running`, `blocked`, `completed`, `failed`, and
`cancelled`. Timeout is represented as lifecycle reason `timeout`; worker patch
adoption is represented as role disposition, not as a `merged` lifecycle.

Subagent execution is not a distributed transaction coordinator. There is no
cross-agent saga behavior or automatic partial-failure repair; parent adoption
remains explicit through worker-result merge and apply surfaces.

## Worker Results

Worker result events record when patch-producing child outputs are prepared,
applied, rejected, or fail to apply. They are parent-owned adoption events, not
child-owned mutation authority.

`worker.results.applied`, `worker.results.apply_failed`, and
`worker.results.rejected` update worker disposition while leaving the child run
lifecycle intact. `worker.results.cleared` removes selected worker results from
the pending apply queue after an explicit apply or reject receipt.

Verifier evidence and stale verification posture may surface as advisory
verification debt in inspection projections. They are not worker-result events
and do not enter worker merge/apply authority.

## Workflow-Derived Surfaces

Workflow-derived events expose derived artifacts, status changes, model preset
selection, and hosted delivery surfaces. They are useful for operator
inspection and UI rendering, but derived artifacts can be rebuilt from stronger
inputs where the family is marked rebuildable.

## Implementation Anchors

- `packages/brewva-gateway/src/daemon/schedule-runner.ts`
- `packages/brewva-vocabulary/src/schedule.ts`
- `packages/brewva-vocabulary/src/workbench.ts`
- `packages/brewva-gateway/src/delegation`
