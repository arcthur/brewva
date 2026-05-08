# Tool Family: Workflow And Scheduling

Workflow and scheduling tools manage skill lifecycle, worker-result adoption,
task state, follow-up intent, schedule intent, resource leases, compaction,
tape/ledger/observability views, rollback, reasoning continuity, and derived
workflow status.

## Boundary

These tools coordinate work over runtime receipts. They do not widen the
runtime transaction boundary beyond the current authoritative action.

## Surfaces

- follow-up and schedule intent
- resource lease request and cancellation
- session compaction
- skill load, completion, and promotion inspection/review/promotion
- worker result merge and apply
- task spec, item, blocker, acceptance, and state views
- tape handoff, information, and search
- ledger, observability, cost, and iteration-fact inspection
- rollback-last-patch
- reasoning checkpoint and revert
- workflow status

## Scheduling

Schedule tools create, update, or cancel intent. Execution is performed by the
scheduler control plane and remains inspectable through event tape, schedule
projection, and child-session records.

## Recovery

Workflow tools should expose deferred, failed, or partial posture as explicit
state. They must not hide retry loops or fabricate completion when adoption or
verification remains unresolved.
