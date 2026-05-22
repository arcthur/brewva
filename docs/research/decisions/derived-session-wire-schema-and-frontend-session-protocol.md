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
  - `packages/brewva-runtime/src/internal/legacy-runtime/engine/sessions/wire.ts`
  - `packages/brewva-runtime/src/runtime/runtime.ts`
  - `packages/brewva-runtime/src/internal/legacy-runtime/engine/sessions/session-wire.ts`
  - `packages/brewva-runtime/src/internal/legacy-runtime/engine/sessions/event-types.ts`
  - `packages/brewva-gateway/src/daemon/gateway-daemon.ts`
  - `packages/brewva-gateway/src/daemon/session-supervisor/index.ts`
  - `packages/brewva-gateway/src/daemon/session-supervisor/session-binding-store.ts`
  - `packages/brewva-gateway/src/daemon/internal/session-wire-status.ts`

## Decision Summary

- Frontend session protocol is a read model, not authority. Tape and receipt-bearing runtime facts remain authoritative. Session wire is the stable derived language consumed by frontend and transport layers.
- Replayable UX requires durable committed presentation receipts. Accepted input and committed terminal rendering are durably captured through `turn_input_recorded` and `turn_render_committed`.
- Live preview traffic remains cache-class. `assistant.delta`, live tool preview frames, `session.status`, and `attempt.started(reason=initial)` are transport-layer cache views and are not replay-critical durable facts.
- Replay emits committed state, not live preview noise. Replay does not emit standalone durable `tool.finished`; committed tool output is carried only by `turn.committed.toolOutputs`.
- Committed assistant output keeps both an aggregate `assistantText` compatibility field and timestamped `assistantSegments[]`; replay seed construction uses the segments so narration, tools, and final answers keep their original order.
- Runtime turn failures after a turn has started are projected as terminal `turn.committed(status=failed)` frames, so frontend replay has a visible terminal state instead of an open half-turn.
- Durable public-session replay must not depend on worker memory. Gateway replay resolves public `sessionId` to archived agent-session tape segments through durable `gateway_session_bound` control-tape receipts.

## Superseded by

- `docs/research/decisions/four-port-runtime-simplification-rfc.md`
