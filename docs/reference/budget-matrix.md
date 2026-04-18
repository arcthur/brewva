# Budget Matrix

This document summarizes Brewva budget pipelines, their units, enforcement boundaries,
and replay/observability sources.

This page is the enforcement summary. Full event-family semantics live in
`docs/reference/events.md`, and config-key meaning stays in
`docs/reference/configuration.md`.

## Runtime Budget Pipelines

| Pipeline                    | Unit                  | Enforcement Point                                                                  | Events                                                                                                                                                                                                                   | Config Key                                                                               | Recovery Source                                                                 |
| --------------------------- | --------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| **Session Cost**            | USD                   | `ToolAccessPolicyService.checkToolAccess` via `SessionCostTracker.getBudgetStatus` | `tool_call_marked`, `cost_update`, `budget_alert`                                                                                                                                                                        | `infrastructure.costTracking.*`                                                          | checkpoint `state.cost` + shared cost fold                                      |
| **Context Injection**       | tokens                | `ContextBudgetManager.planInjection`                                               | `context_injected`, `context_injection_dropped`                                                                                                                                                                          | `infrastructure.contextBudget.*`                                                         | runtime-local state only                                                        |
| **Context Compaction Gate** | context window ratio  | `ContextPressureService.checkContextCompactionGate`                                | `context_compaction_advisory`, `context_compaction_requested`, `context_compaction_gate_armed`, `critical_without_compact`, `context_compaction_gate_blocked_tool`, `session_compact`, `context_compaction_gate_cleared` | `infrastructure.contextBudget.compaction.*`, `infrastructure.contextBudget.thresholds.*` | runtime-local gate state; `session_compact` receipts remain durable evidence    |
| **Context Arena SLO**       | entry count           | `ContextArena.ensureAppendCapacity`                                                | `context_arena_slo_enforced`                                                                                                                                                                                             | `infrastructure.contextBudget.arena.maxEntriesPerSession`                                | runtime-local arena state only                                                  |
| **Governance Checks**       | checks / turn         | effect authorization plus verification/cost/compaction governance hooks            | `proposal_*`, `decision_receipt_recorded`, `governance_verify_spec_*`, `governance_cost_anomaly_*`, `governance_compaction_integrity_*`                                                                                  | `BrewvaRuntimeOptions.governancePort`                                                    | tape events + checkpoint replay                                                 |
| **Parallel**                | concurrent/total runs | `ParallelBudgetManager.acquire`                                                    | `parallel_slot_rejected` plus durable delegation lifecycle events such as `subagent_*` and `worker_results_applied`                                                                                                      | `parallel.*` (`parallel.maxTotalPerSession`)                                             | durable delegation events reconciled into runtime-local slot state on hydration |

## Skill Contract Budgets (Orthogonal)

Skill contract budgets are enforced at tool gate and are separate from session USD budget:

| Budget         | Unit                                                               | Modes                                                                       | Event Signals                               |
| -------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------- | ------------------------------------------- |
| `maxTokens`    | tracked tokens (`input + output + cacheWrite`, excludes cacheRead) | `off \| warn \| enforce` (via `security.enforcement.skillMaxTokensMode`)    | `skill_budget_warning`, `tool_call_blocked` |
| `maxToolCalls` | tool call count                                                    | `off \| warn \| enforce` (via `security.enforcement.skillMaxToolCallsMode`) | `skill_budget_warning`, `tool_call_blocked` |

## `costTracking.enabled` Semantics

For compaction, this matrix lists the primary advisory, hard-gate, and durable
receipt events only. Hosted auto-compaction controller telemetry
(`context_compaction_auto_*`) is covered in `docs/reference/events.md`.

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
- Context-injection and compaction observability events improve diagnostics, but
  they do not currently rebuild the arena or compaction planner from tape;
  `session_compact` remains durable evidence, not current gate-state hydration.
- Parallel slot state remains implementation-local at runtime, but hydration
  can reconstruct the active/started budget snapshot from durable delegation
  lifecycle events before normal execution continues.
- `context_arena_slo_enforced` records that the ceiling was hit; it is not a
  replay contract for reconstructing exact prior arena contents.
