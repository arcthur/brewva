# Tool Family: Workflow And Scheduling

Workflow and scheduling tools manage follow-up intent, schedule intent,
resource leases, compaction, tape handoff/search, and derived workflow status.

## Boundary

These tools coordinate work over runtime receipts. They do not widen the
runtime transaction boundary beyond the current authoritative action.

## Surfaces

- follow-up and schedule intent
- resource lease request and cancellation
- session compaction
- tape handoff, information, and search
- workflow status
- reasoning checkpoint and revert

## Scheduling

Schedule tools create, update, or cancel intent. Execution is performed by the
scheduler control plane and remains inspectable through event tape, schedule
projection, and child-session records.

## Recovery

Workflow tools should expose deferred, failed, or partial posture as explicit
state. They must not hide retry loops or fabricate completion when adoption or
verification remains unresolved.
