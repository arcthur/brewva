# Decision: Future Model Context Lifecycle

## Metadata

- Decision: continuation anchors stay replayable while context-pressure response moves into hosted context lifecycle policy.
- Date: `2026-06-01`
- Status: accepted
- Stable docs:
  - `docs/reference/commands/interactive.md`
  - `docs/reference/hosted-dynamic-context.md`
  - `docs/reference/tools/workflow-and-scheduling.md`
  - `docs/architecture/cognitive-product-architecture.md`
  - `docs/architecture/system-architecture.md`
  - `docs/reference/events/runtime.md`
- Code anchors:
  - `packages/brewva-cli/src/shell/commands/shell-command-registry.ts`
  - `packages/brewva-cli/src/shell/domain/effects.ts`
  - `packages/brewva-cli/src/operator/inspect/work-card.ts`
  - `packages/brewva-vocabulary/src/internal/session.ts`
  - `packages/brewva-gateway/src/hosted/internal/context/context-lifecycle.ts`
  - `packages/brewva-gateway/src/hosted/internal/context/workbench-context.ts`
  - `packages/brewva-gateway/src/hosted/internal/provider/request/provider-request-reduction.ts`
  - `packages/brewva-gateway/src/hosted/internal/context/evidence/context-evidence.ts`

## Decision Summary

- Handoff is no longer a default product action. It remains stable only as the `/handoff` slash input, `tape_handoff` tool name, and `tape.handoff` persisted event family.
- The product concept is `continuation anchor`: a replayable resume marker with optional name, summary, and next steps. Recording one does not compact context or reduce message history.
- CLI internals use `session.continuationAnchor` and `ContinuationAnchorDraft`. `/handoff` maps into that effect instead of preserving a `session.handoff` internal path.
- `TaskWorkCardProjection` is v2 and exposes `continuationAnchor`, not `handoff`. The projection remains rebuildable and non-authoritative.
- Hosted dynamic context renders `[LatestContinuationAnchor]` only when the latest anchor has continuation metadata; checkpoint-only anchors stay omitted.
- Context pressure policy is centralized in the hosted `context-lifecycle` module: pressure action, nudge cadence, auto-compaction eligibility, transient-reduction eligibility, and continuation-anchor relevance are decided there.
- Context evidence reports include continuation-anchor pressure metrics so context pressure incidents can be distinguished from ordinary resume markers.

## Non-Goals

- Do not delete `/handoff`, `tape_handoff`, or the persisted `tape.handoff` event family.
- Do not add runtime roots, provider defaults, config keys, package public exports, or hidden memory admission paths.

## Superseded by

- None.
