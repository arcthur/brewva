# Decision: Hosted Thread Loop And Unified Recovery Decisions

## Metadata

- Decision: the former gateway turn adapter was the gateway-internal continuation owner above the substrate turn loop.
- Date: `2026-04-20`
- Status: accepted
- Stable docs:
  - `docs/architecture/system-architecture.md`
  - `docs/reference/session-lifecycle.md`
  - `docs/reference/extensions.md`
  - `docs/journeys/internal/context-and-compaction.md`
  - `docs/reference/gateway-control-plane-protocol.md`
- Code anchors:
  - `packages/brewva-runtime/src/runtime/engine/turn.ts`
  - `packages/brewva-gateway/src/hosted/internal/turn-adapter/runtime-turn-adapter.ts`
  - `packages/brewva-gateway/src/hosted/internal/turn-adapter/hosted-prompt-attempt.ts`

## Decision Summary

- This decision is no longer active. Hosted entrypoints now enter a thin adapter that calls `runtime.turn(...)` and translates frames for transport.
- Runtime owns provider streaming, tool transactions, context pressure, interrupt handling, and terminal commit.
- Gateway hosted code does not own recovery policy, transition truth, or a substrate turn loop.
- Detailed recovery history stays process-local as the historical non-durable invariant; active recovery state is now rebuilt from canonical tape projections.

## Superseded by

- `docs/research/decisions/four-port-runtime-simplification-rfc.md`
