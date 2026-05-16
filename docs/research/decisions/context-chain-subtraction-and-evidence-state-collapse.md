# Decision: Context Chain Subtraction and Evidence-State Collapse

## Metadata

- Decision: collapse the parallel context-and-compaction surfaces into one decider, one evidence sink, one commit, and one recovery projection.
- Date: `2026-05-16`
- Status: accepted
- Stable docs:
  - `docs/journeys/internal/context-and-compaction.md`
  - `docs/reference/hosted-dynamic-context.md`
  - `docs/reference/runtime.md`
  - `docs/reference/configuration.md`
  - `docs/reference/token-cache.md`
  - `docs/reference/session-lifecycle.md`
  - `docs/reference/budget-matrix.md`
  - `skills/project/shared/critical-rules.md`
  - `skills/project/shared/anti-patterns.md`
- Code anchors:
  - `packages/brewva-runtime/src/domain/context/eligibility.ts`
  - `packages/brewva-runtime/src/domain/context/context.ts`
  - `packages/brewva-runtime/src/domain/context/context-compaction.ts`
  - `packages/brewva-runtime/src/domain/context/context-compaction-gate.ts`
  - `packages/brewva-runtime/src/domain/context/history-view-baseline.ts`
  - `packages/brewva-runtime/src/domain/context/runtime-surface.ts`
  - `packages/brewva-runtime/src/domain/sessions/session-state.ts`
  - `packages/brewva-runtime/src/config/normalize-infrastructure.ts`
  - `packages/brewva-gateway/src/hosted/internal/context/materialization.ts`
  - `packages/brewva-gateway/src/hosted/internal/context/hosted-compaction-controller.ts`
  - `packages/brewva-gateway/src/hosted/internal/context/evidence/context-evidence.ts`
  - `packages/brewva-gateway/src/hosted/internal/provider/request/provider-request-reduction.ts`
  - `packages/brewva-gateway/src/hosted/internal/provider/request/provider-request-reduction-walker.ts`
  - `packages/brewva-gateway/src/hosted/internal/thread-loop/recovery/projection.ts`

## Decision Summary

- One shared eligibility decider (`resolveCompactionEligibility`) owns disabled, no-usage, recent-compaction cooldown, advisory, hard-limit, predicted-overflow, recovery, and breaker decisions; the hosted controller, hosted context gate, and provider-request reduction all consume it through `inspect.context.compaction.resolveEligibility(...)`.
- `PromptStability`, `TransientReduction`, `ProviderCacheObservation`, and `ProviderCacheFingerprint` are no longer durable session state. They are written through the runtime context evidence sink and read through `inspect.context.evidence.latest(sessionId, kind)`. `VisibleReadState` remains the only retained session-state slot because it is authoritative for tool-dispatch staleness.
- Hosted context materialization performs direct lifecycle calls. There is no 13-effect plan/commit DAG; the effect list captures observed lifecycle events, not a declarative ordering.
- `session_compact` commit is synchronous governance integrity only, with a 1-second timeout, no disk artifact, no ledger row, and caller-passed `cacheImpact` and `referenceContextDigest`. `HistoryViewBaselineArtifact` disk writes are gone; the history-view baseline is derived from `session_compact` receipts and an in-memory cache.
- `HostedCompactionController` retains only operational state (`turnIndex`, `autoCompactionInFlight`, `autoCompactionWatchdog`, `autoCompactionAttemptId`, `activeAutoCompactionAttemptId`). All policy and posture state is read from runtime inspect or the manager.
- The provider-cache cold-start heuristic is a `message_end` tape read bounded by `infrastructure.contextBudget.providerCacheStalenessMs`, not a parallel observation state.
- Recovery dispatch reads one `HostedRecoveryProjection` snapshot per turn; `OutputBudgetState` and `recovery.ts` consume the projection rather than maintaining shadow state.
- `infrastructure.contextBudget` is contracted to twelve normalized keys: `enabled`, `thresholds.{hardRatio,advisoryRatio,headroomTokens}`, `dynamicTailTokens`, `predictedTurnGrowthTokens`, `providerCacheStalenessMs`, `consequenceDigestMaxChars`, `compactionInstructions`, and `compaction.{minTurnsBetween,protectedTools,tailProtectTokens}`.
- `ContextService` exposes evidence, visible-read, and compaction read/operator helpers. No legacy `getPromptStability`, `getTransientReduction`, or `getProviderCacheObservation` ports remain.

## Superseded by

- None.
