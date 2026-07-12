# Budget Matrix

This document summarizes Brewva budget pipelines, their units, enforcement boundaries,
and replay/observability sources.

This page is the enforcement summary. Full event-family semantics live in
`docs/reference/events/README.md`, and config-key meaning stays in
`docs/reference/configuration.md`.

## Runtime Budget Pipelines

| Pipeline                    | Unit                  | Enforcement Point                                                                                | Events                                                                                                                                           | Config Key                                                                                                                                                                      | Recovery Source                                                                  |
| --------------------------- | --------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| **Session Cost**            | USD                   | `checkToolAccess` (runtime security) over the four-port cost ops (`sessionExceeded` / `blocked`) | `tool_call_marked`, `cost_update`, `budget_alert`                                                                                                | `infrastructure.costTracking.*`                                                                                                                                                 | checkpoint `state.cost` + shared cost fold                                       |
| **Workbench Context**       | tokens                | model-authored `workbench_note` / `workbench_evict` plus request rendering                       | `workbench_note_recorded`, `workbench_eviction_recorded`, `workbench_eviction_undone`, `session_compact`                                         | `infrastructure.contextBudget.*`                                                                                                                                                | durable workbench entries + compaction baselines                                 |
| **Context Compaction Gate** | context window ratio  | stateless gate evaluation plus shared compaction eligibility                                     | `context_compaction_advisory`, `context_compaction_gate_armed`, `critical_without_compact`, `session_compact`, `context_compaction_gate_cleared` | `infrastructure.contextBudget.compaction.*`, `infrastructure.contextBudget.thresholds.*`, `infrastructure.contextBudget.predictedTurnGrowthRatio` / `predictedTurnGrowthTokens` | replayed budget policy state; `session_compact` receipts remain durable evidence |
| **Tool Authority**          | tool calls            | `KernelPort.beginToolCall` action-policy resolution                                              | `tool.proposed`, `tool.aborted`, `approval.requested`, `approval.decided`, `tool.committed`                                                      | `security.actionAdmissionOverrides.*`                                                                                                                                           | canonical tape tool commitment projection                                        |
| **Parallel**                | concurrent/total runs | `ParallelSlotPort.acquire`                                                                       | `parallel_slot_rejected` plus durable delegation lifecycle events such as `subagent_*` and `worker_results_applied`                              | `parallel.*` (`parallel.maxTotalPerSession`)                                                                                                                                    | durable delegation events reconciled into runtime-local slot state on hydration  |

## Skill Budgets

Skills are catalog documents, not runtime execution envelopes. Brewva does not
track per-skill token or tool-call budgets. Cost is observed by Runtime and tool
admission is owned by Kernel action policy.

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

Governance is expressed through per-tool governance descriptors consumed inside the
kernel decision path, not a separate adapter interface:

- `toolGovernanceRequiresEffectCommitment` decides whether an effectful tool action
  is approval-bound (must stay deferred until approved) or may execute directly.
  Descriptors are derived through `deriveToolGovernanceDescriptor` /
  `getToolGovernanceDescriptor`.
- `validateCompactionSummary` validates compaction summaries against the durable
  baseline and surfaces integrity failures.

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
- Context-arena ceilings are not replay contracts; recovery relies on
  workbench entries, compaction baselines, and request-shaping events.

## Context Budget, Evidence, And Outbound Reduction

`infrastructure.contextBudget.thresholds` is the physical budget layer:
`hardRatio` sets the hard gate, `advisoryRatio` sets the compact-soon line, and
`headroomTokens` reserves fixed headroom before ratio checks. The manager adds
the configured growth floor (`predictedTurnGrowthRatio` scaled by the context
window, or the absolute `predictedTurnGrowthTokens` override) when evaluating
projected overflow; there is no separate model-physics or predictive-growth
sub-surface.

Prompt-stability, transient-reduction, and provider-cache observations are not
runtime session-state slots. Hosted code writes them to the runtime latest
evidence ring and to `.orchestrator/context-evidence`; losing that latest ring
on restart changes diagnostics and request efficiency only, not replay truth.

The transient outbound provider-request reduction plugin honors two
compaction-scoped policies on top of the recent-window protection:

- `protectedTools` exempts critical tool families from clearing so workbench
  and recall observations cannot be silently dropped from a high-pressure
  outbound copy.
- the protected tail budget (`tailProtectRatio` scaled by the session context
  window, or the absolute `tailProtectTokens` override) walks the candidate
  tail backwards and preserves candidates whose cumulative tail token estimate
  fits within the budget. Only the prefix beyond that boundary is eligible for
  reduction.

Outbound reduction is non-durable and does not change the replay record; the
durable transcript and `session_compact` receipts remain the authoritative
sources.

Compaction active-set provenance is recorded on
`session.compaction.committed.inputProvenance`. It is an observability receipt,
not a new budget authority: the active set is limited to current workbench
entries, selected skill invocation records, surfaced SkillCard resource refs,
capability receipts, pinned or latest-used recall refs, and the previous
compact baseline. The receipt records `hiddenRecallSearch=false` so compacting
cannot silently widen recall.
