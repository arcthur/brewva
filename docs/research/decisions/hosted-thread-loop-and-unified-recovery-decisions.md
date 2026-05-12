# Decision: Hosted Thread Loop And Unified Recovery Decisions

## Metadata

- Decision: `HostedThreadLoop` is the gateway-internal continuation owner above the substrate turn loop.
- Date: `2026-04-20`
- Status: accepted
- Stable docs:
  - `docs/architecture/system-architecture.md`
  - `docs/reference/session-lifecycle.md`
  - `docs/reference/extensions.md`
  - `docs/journeys/internal/context-and-compaction.md`
  - `docs/reference/gateway-control-plane-protocol.md`
- Code anchors:
  - `packages/brewva-substrate/src/turn/loop.ts`
  - `packages/brewva-substrate/src/turn/controller.ts`
  - `packages/brewva-gateway/src/hosted/internal/thread-loop/thread-loop-types.ts`
  - `packages/brewva-gateway/src/hosted/internal/thread-loop/thread-loop-profiles.ts`
  - `packages/brewva-gateway/src/hosted/internal/thread-loop/thread-loop-decision-resolver.ts`
  - `packages/brewva-gateway/src/hosted/internal/thread-loop/hosted-thread-loop.ts`
  - `packages/brewva-gateway/src/hosted/internal/compaction/recovery.ts`
  - `packages/brewva-gateway/src/hosted/internal/thread-loop/hosted-prompt-attempt.ts`
  - `packages/brewva-gateway/src/hosted/internal/thread-loop/error-classification.ts`

## Decision Summary

- `HostedThreadLoop` is the gateway-internal continuation owner above the substrate turn loop.
- `packages/brewva-substrate/src/turn/loop.ts` remains the low-level model/tool primitive for streaming, tool calls, queued prompts, in-flight steer application, follow-up messages, request authorization, and context transformation.
- hosted entrypoints enter the canonical hosted turn envelope, which resolves explicit profiles before running the loop: `interactive`, `print`, `channel`, `scheduled`, `heartbeat`, `wal_recovery`, or `subagent`.
- hosted recovery decisions use one turn-local `ThreadLoopState` projection and a small `ThreadLoopDecision` union.
- `HostedTurnTransitionCoordinator` remains event-derived transition, breaker, and audit state; it is not the business-policy engine.
- Detailed recovery history stays process-local.

## Superseded by

- None.
