# Decision: Canonical Hosted Turn Envelope

## Metadata

- Decision: `HostedThreadLoop` remains the gateway-internal attempt, continuation, and recovery body.
- Date: `2026-04-21`
- Status: accepted
- Stable docs:
  - `docs/reference/session-lifecycle.md`
  - `docs/reference/runtime-plugins.md`
  - `docs/reference/events/README.md`
- Code anchors:
  - `packages/brewva-gateway/src/session/turn-envelope.ts`
  - `packages/brewva-gateway/src/session/thread-loop-profiles.ts`
  - `packages/brewva-gateway/src/session/thread-loop-types.ts`
  - `packages/brewva-gateway/src/session/hosted-thread-loop.ts`
  - `packages/brewva-gateway/src/subagents/entry.ts`
  - `packages/brewva-runtime/src/contracts/session-wire.ts`
  - `packages/brewva-runtime/src/services/session-wire.ts`
  - `packages/brewva-gateway/src/session/worker-main.ts`

## Decision Summary

- `HostedThreadLoop` remains the gateway-internal attempt, continuation, and recovery body.
- production hosted prompt entrypoints enter through `packages/brewva-gateway/src/session/turn-envelope.ts`.
- the envelope owns hosted-loop profile resolution, runtime-turn binding, accepted-turn receipts, schedule-trigger prelude, WAL recovery transitions, terminal render receipts, and suspended-vs-terminal status mapping.
- every production accepted hosted prompt turn records `turn_input_recorded`.
- `turn_render_committed` is recorded only for terminal `completed | failed | cancelled` outcomes.
- Envelope diagnostics stay process-local; No durable envelope-diagnostics event should be added.

## Superseded by

- None.
