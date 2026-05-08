# Research: Model-Operated Working Memory Evaluation

## Document Metadata

- Status: `active`
- Owner: runtime, gateway, and product architecture maintainers
- Last reviewed: `2026-05-08`
- Promotion target:
  - `docs/reference/hosted-dynamic-context.md`
  - `docs/reference/token-cache.md`
  - `docs/reference/tools/memory-and-recall.md`
  - `docs/journeys/internal/context-and-compaction.md`

## Problem Statement And Scope Boundaries

The model-operated working-memory reset is accepted. This note only tracks the
evidence still needed before the validation work can leave `active/`.

This note covers:

- long-session prompt-cache and input-cost evidence
- compaction drift and emergency-fallback rates
- on-demand recall usefulness after removing hidden per-turn recall admission
- workbench eviction and history-view baseline behavior in representative runs
- operator evidence for degraded recovery and damaged-baseline diagnosis

This note does not reopen:

- context-source provider registries
- default prompt injection as the cognitive path
- `skill_load` gates before investigation
- deterministic compaction as the primary continuation path
- typed deliberation or narrative memory artifacts
- hidden per-turn recall selection

## Working Hypotheses

- Giving the model workbench operations and on-demand recall improves task
  continuity without reintroducing runtime-owned thought-path control.
- Cache-aware transient reduction should keep long-session prompt-cache hit rate
  at or above the reset target while reducing forced compaction pressure.
- LLM primary compaction plus sanitized history-view baselines should reduce
  post-compact task drift compared with deterministic projection summaries.

## Source Anchors

- Accepted reset decision:
  `docs/research/decisions/model-operated-working-memory-and-context-governance-reset.md`
- Prefix and cache validation:
  `docs/research/active/prefix-stable-context-management-and-progressive-compaction.md`
- Recovery baseline validation:
  `docs/research/active/recovery-first-context-governance-and-history-view-baselines.md`
- Context evidence reporting:
  `packages/brewva-gateway/src/runtime-plugins/context-evidence.ts`
  `packages/brewva-gateway/src/runtime-plugins/context-evidence/store.ts`
  `script/report-context-evidence.ts`
- Compaction and request shaping:
  `packages/brewva-gateway/src/host/compaction-summary-generator.ts`
  `packages/brewva-gateway/src/runtime-plugins/provider-request-reduction.ts`
- Model-operated memory tools:
  `packages/brewva-tools/src/families/memory/workbench.ts`
  `packages/brewva-tools/src/families/memory/recall.ts`

## Validation Signals

- Representative sessions longer than ten turns show prompt-cache hit rate at
  or above 70%.
- Stable-prefix evidence reports `stablePrefix=true` on at least 95% of
  semantically unchanged scope-local turns.
- Input-token cost per effective turn does not regress beyond the configured
  stop-loss threshold.
- `session_compact` receipts show LLM primary compaction as the normal path and
  deterministic emergency fallback as rare, marked degraded behavior.
- Recovery reports distinguish helper-artifact loss from replay-correctness
  issues during damaged-baseline or exact-history-over-budget incidents.

## Promotion Criteria

- `bun run report:context-evidence` can produce at least one representative
  promotion report satisfying the cache and cost thresholds.
- Long-session review confirms compaction summaries preserve current objective,
  recent user corrections, failed attempts, and next-step intent without task
  drift.
- On-demand recall review shows useful retrieval without hidden per-turn recall
  admission.
- Stable reference docs describe the accepted model-operated architecture and
  link remaining validation evidence without treating this note as normative.
- If evidence fails a threshold, open a new focused active RFC for the failing
  mechanism instead of reopening the accepted reset decision.

## Surface Budget

- Required authored fields: 0 -> 0
- Optional authored fields: 0 -> 0
- Author-facing concepts: 0 -> 0
- Inspect surfaces: 0 -> 0
- Routing/control-plane decision points: 0 -> 0
