# Decision: Derived Session Wire Schema And Frontend Session Protocol

## Metadata

- Decision: Frontend session protocol is a read model, not authority. Tape and receipt-bearing runtime facts remain authoritative. Session wire is the stable derived language consumed by frontend and transport layers.
- Date: `2026-04-23`
- Status: accepted
- Stable docs:
  - `docs/architecture/system-architecture.md`
  - `docs/reference/runtime.md`
  - `docs/reference/events/README.md`
  - `docs/reference/gateway-control-plane-protocol.md`
  - `docs/reference/session-lifecycle.md`
  - `docs/journeys/operator/interactive-session.md`
- Code anchors:
  - `packages/brewva-runtime/src/contracts/session-wire.ts`
  - `packages/brewva-runtime/src/runtime.ts`
  - `packages/brewva-runtime/src/services/session-wire.ts`
  - `packages/brewva-runtime/src/events/event-types.ts`
  - `packages/brewva-gateway/src/daemon/gateway-daemon.ts`
  - `packages/brewva-gateway/src/daemon/session-supervisor.ts`
  - `packages/brewva-gateway/src/daemon/session-binding-tape.ts`
  - `packages/brewva-gateway/src/daemon/session-wire-status.ts`

## Decision Summary

- Frontend session protocol is a read model, not authority. Tape and receipt-bearing runtime facts remain authoritative. Session wire is the stable derived language consumed by frontend and transport layers.
- Replayable UX requires durable committed presentation receipts. Accepted input and committed terminal rendering are durably captured through `turn_input_recorded` and `turn_render_committed`.
- Live preview traffic remains cache-class. `assistant.delta`, live tool preview frames, `session.status`, and `attempt.started(reason=initial)` are transport-layer cache views and are not replay-critical durable facts.
- Replay emits committed state, not live preview noise. Replay does not emit standalone durable `tool.finished`; committed tool output is carried only by `turn.committed.toolOutputs`.
- Durable public-session replay must not depend on worker memory. Gateway replay resolves public `sessionId` to archived agent-session tape segments through durable `gateway_session_bound` control-tape receipts.

## Superseded by

- None.
