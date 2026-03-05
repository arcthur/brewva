# Runtime Events

This reference summarizes the current event families after governance-kernel
convergence.

## Event Envelope

Every runtime event follows the same envelope shape:

- `id`
- `sessionId`
- `type`
- `timestamp`
- `turn` (optional)
- `payload` (optional)

## Audit-Critical Families

- `anchor`
- `checkpoint`
- `task_event`
- `truth_event`
- `tool_result_recorded`
- `verification_outcome_recorded`
- schedule lifecycle events
- execution routing/isolation events

These are retained under `infrastructure.events.level=audit`.

## Operational Families

- `context_injected`
- `context_injection_dropped`
- `context_compaction_*`
- `context_arena_slo_enforced`
- `cost_update`
- `budget_alert`
- `skill_*` lifecycle and cascade events
- `turn_wal_*`

These are retained under `ops` and `debug`.

## Governance Families

- `governance_verify_spec_passed`
- `governance_verify_spec_failed`
- `governance_verify_spec_error`
- `governance_cost_anomaly_detected`
- `governance_cost_anomaly_error`
- `governance_compaction_integrity_checked`
- `governance_compaction_integrity_failed`
- `governance_compaction_integrity_error`

Governance events are available at `ops` and `debug` levels and remain replayable from tape.

## Memory Projection Families

- `memory_projection_ingested`
- `memory_projection_refreshed`
- `memory_rebuild_from_tape`

Memory events describe deterministic projection state only.

## Removed Families

The following families are not part of the current kernel path:

- adaptive inference event families
- multi-tier memory enrichment event families
- optional external retrieval decision families
