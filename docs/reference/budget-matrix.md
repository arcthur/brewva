# Budget Matrix

This document summarizes Brewva budget pipelines, their units, enforcement boundaries,
and replay/observability sources.

This page is the enforcement summary. Full event-family semantics live in
`docs/reference/events/README.md`, and config-key meaning stays in
`docs/reference/configuration.md`.

## Runtime Budget Pipelines

| Pipeline                    | Unit                  | Enforcement Point                                                                  | Events                                                                                                                                                                                                                   | Config Key                                                                                                                                      | Recovery Source                                                                 |
| --------------------------- | --------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| **Session Cost**            | USD                   | `ToolAccessPolicyService.checkToolAccess` via `SessionCostTracker.getBudgetStatus` | `tool_call_marked`, `cost_update`, `budget_alert`                                                                                                                                                                        | `infrastructure.costTracking.*`                                                                                                                 | checkpoint `state.cost` + shared cost fold                                      |
| **Workbench Context**       | tokens                | model-authored `workbench_note` / `workbench_evict` plus request rendering         | `workbench_note_recorded`, `workbench_eviction_recorded`, `workbench_eviction_undone`, `workbench_baseline_committed`                                                                                                    | `infrastructure.contextBudget.*`                                                                                                                | durable workbench entries + compaction baselines                                |
| **Context Compaction Gate** | context window ratio  | stateless `evaluateContextCompactionGate`                                          | `context_compaction_advisory`, `context_compaction_requested`, `context_compaction_gate_armed`, `critical_without_compact`, `context_compaction_gate_blocked_tool`, `session_compact`, `context_compaction_gate_cleared` | `infrastructure.contextBudget.compaction.*`, `infrastructure.contextBudget.thresholds.*`, `infrastructure.contextBudget.predictiveTurnGrowth.*` | runtime-local gate state; `session_compact` receipts remain durable evidence    |
| **Governance Checks**       | checks / turn         | effect authorization plus verification/cost/compaction governance hooks            | `proposal_*`, `decision_receipt_recorded`, `governance_verify_spec_*`, `governance_cost_anomaly_*`, `governance_compaction_integrity_*`                                                                                  | `BrewvaRuntimeOptions.governancePort`                                                                                                           | tape events + checkpoint replay                                                 |
| **Parallel**                | concurrent/total runs | `ParallelBudgetManager.acquire`                                                    | `parallel_slot_rejected` plus durable delegation lifecycle events such as `subagent_*` and `worker_results_applied`                                                                                                      | `parallel.*` (`parallel.maxTotalPerSession`)                                                                                                    | durable delegation events reconciled into runtime-local slot state on hydration |

## Skill Budgets

Skills are catalog documents, not runtime execution envelopes. Brewva no longer
tracks per-skill token or tool-call budgets. Cost and tool admission are owned by
session cost policy and effect governance.

## `costTracking.enabled` Semantics

For compaction, this matrix lists the primary advisory, hard-gate, and durable
receipt events only. Hosted auto-compaction controller telemetry
(`context_compaction_auto_*`) is covered in `docs/reference/events/README.md`.

When `infrastructure.costTracking.enabled=false`:

- usage accounting is still recorded (`totalTokens`, `totalCostUsd`, model/skill/tool breakdown)
- budget blocking is disabled (`budget.blocked=false`, `budget.sessionExceeded=false`)
- budget alerts are suppressed (`alerts=[]`)

When `enabled=true`, session budget behavior is controlled by:

- `maxCostUsdPerSession`
- `alertThresholdRatio`
- `actionOnExceed` (`warn` or `block_tools`)

## Governance Check Semantics

Governance checks are optional adapters, but once configured they participate in the
runtime decision loop:

- `authorizeEffectCommitment` decides whether approval-bound effectful tool actions
  may execute or must stay deferred.
- `verifySpec` can convert a verification pass into a governance failure with blocker evidence.
- `detectCostAnomaly` emits anomaly diagnostics without changing session accounting totals.
- `checkCompactionIntegrity` validates compaction summaries and emits governance integrity events.

## Notes On Replay Precision

- Behavior-changing budget state should be replay-derived when it affects
  admission, authorization, or recovery semantics.
- Visibility-only budget state should surface through projection or explicit
  inspection products rather than hiding inside local planners.
- Performance-only counters, fingerprints, and caches may remain local if
  losing them changes efficiency only and does not alter replayable outcomes.
- Context and compaction observability events improve diagnostics, but they do
  not rebuild transient request shaping from tape; `session_compact` remains
  durable evidence, not current gate-state hydration.
- Parallel slot state remains implementation-local at runtime, but hydration
  can reconstruct the active/started budget snapshot from durable delegation
  lifecycle events before normal execution continues.
- Deleted context-arena ceilings are not replay contracts; recovery relies on
  workbench entries, compaction baselines, and request-shaping events.

## Adaptive Headroom And Outbound Reduction

`infrastructure.contextBudget.thresholds.*HeadroomTokens` are tuning floors,
not fixed reservations. When a provider reports `maxOutputTokens` in usage
telemetry the manager substitutes `max(configured, maxOutputTokens)` for that
turn so larger output windows do not silently push the conversation past the
projected hard limit. `coerceContextBudgetUsage` is the entrypoint that
extracts the field from raw provider responses; usage objects without
`maxOutputTokens` fall back to the configured headroom.

The transient outbound provider-request reduction plugin honors two
compaction-scoped policies on top of the recent-window protection:

- `protectedTools` exempts critical tool families from clearing so workbench
  and recall observations cannot be silently dropped from a high-pressure
  outbound copy.
- `tailProtectTokens` walks the candidate tail backwards and preserves
  candidates whose cumulative tail token estimate fits within the budget.
  Only the prefix beyond that boundary is eligible for reduction.

Outbound reduction is non-durable and does not change the replay record; the
durable transcript and `session_compact` receipts remain the authoritative
sources.
