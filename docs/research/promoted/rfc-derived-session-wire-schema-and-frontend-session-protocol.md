# Research: Derived Session Wire Schema And Frontend Session Protocol

## Document Metadata

- Status: `promoted`
- Owner: gateway and runtime maintainers
- Last reviewed: `2026-04-05`
- Promotion target:
  - `docs/architecture/system-architecture.md`
  - `docs/reference/runtime.md`
  - `docs/reference/events.md`
  - `docs/reference/gateway-control-plane-protocol.md`
  - `docs/reference/session-lifecycle.md`
  - `docs/journeys/operator/interactive-session.md`

## Promotion Summary

This note is now a short status pointer.

The promoted decision is:

- `brewva.session-wire.v2` is the only public frontend session protocol
- runtime owns the durable session-wire contract and compiler surface:
  `inspect.sessionWire.query(...)`, `inspect.sessionWire.subscribe(...)`, and
  the shared event-log compiler helpers
- gateway owns public-session replay ordering, websocket framing, live cache
  augmentation, and public-session lookup through durable
  `gateway_session_bound` control-tape receipts
- `turn_input_recorded` and `turn_render_committed` are the durable
  presentation receipts for replayable turn UX
- replay and live are semantically aligned but not frame-isomorphic
- legacy `session.turn.*` transport grammar is removed rather than kept as a
  compatibility layer

Stable implementation now includes:

- stable runtime contracts for `SessionWireFrame`, `ContextPressureView`, and
  `ToolOutputView`
- a runtime-owned durable compiler for `turn_input_recorded`,
  `turn_render_committed`, `session_turn_transition`, approval receipts,
  subagent lifecycle receipts, and `session_shutdown`
- gateway live cache frames for `assistant.delta`, initial `attempt.started`,
  tool preview traffic, and `session.status`
- gateway-owned authoritative tool-attempt binding so live `tool.started`,
  `tool.progress`, and `tool.finished` carry explicit `attemptId` without
  guessing from the current active attempt
- late superseded-attempt live tool frames remain observable under their
  original bound `attemptId`, while committed replay continues to converge only
  through `turn.committed.toolOutputs`
- replay deduplication across replay/live overlap windows
- durable public-session binding receipts replacing the old process-local JSON
  replay locator

Stable references:

- `docs/architecture/system-architecture.md`
- `docs/reference/runtime.md`
- `docs/reference/events.md`
- `docs/reference/gateway-control-plane-protocol.md`
- `docs/reference/session-lifecycle.md`
- `docs/journeys/operator/interactive-session.md`

## Stable Contract Summary

The promoted contract is:

1. Frontend session protocol is a read model, not authority.
   Tape and receipt-bearing runtime facts remain authoritative. Session wire is
   the stable derived language consumed by frontend and transport layers.
2. Replayable UX requires durable committed presentation receipts.
   Accepted input and committed terminal rendering are durably captured through
   `turn_input_recorded` and `turn_render_committed`.
3. Live preview traffic remains cache-class.
   `assistant.delta`, live tool preview frames, `session.status`, and
   `attempt.started(reason=initial)` are transport-layer cache views and are
   not replay-critical durable facts.
4. Replay emits committed state, not live preview noise.
   Replay does not emit standalone durable `tool.finished`; committed tool
   output is carried only by `turn.committed.toolOutputs`.
5. Durable public-session replay must not depend on worker memory.
   Gateway replay resolves public `sessionId` to archived agent-session tape
   segments through durable `gateway_session_bound` control-tape receipts.
6. Removed protocol surfaces stay removed.
   The promoted contract does not keep `session.turn.*`, reducer aliases, or
   compatibility wrappers for the old grammar.

## Validation Status

Promotion is backed by:

- runtime contract and compiler coverage for committed turns, recovery-driven
  attempt transitions, approval receipts, subagent receipts, provenance, and
  replay deduplication
- gateway supervision coverage for replay ordering, replay/live overlap,
  session-status transitions, and terminal `turn.committed` resolution
- archived replay coverage across multiple agent-session segments resolved
  through `gateway_session_bound` control-tape receipts
- reference and architecture docs aligned with the latest-only transport
  cutover and durable binding design
- repository verification via `bun run check`, `bun test`,
  `bun run test:docs`, `bun run format:docs:check`, and `bun run test:dist`

## Source Anchors

- `packages/brewva-runtime/src/contracts/session-wire.ts`
- `packages/brewva-runtime/src/runtime.ts`
- `packages/brewva-runtime/src/services/session-wire.ts`
- `packages/brewva-runtime/src/events/event-types.ts`
- `packages/brewva-gateway/src/daemon/gateway-daemon.ts`
- `packages/brewva-gateway/src/daemon/session-supervisor.ts`
- `packages/brewva-gateway/src/daemon/session-binding-tape.ts`
- `packages/brewva-gateway/src/daemon/session-wire-status.ts`
- `packages/brewva-gateway/src/runtime-plugins/event-stream.ts`
- `packages/brewva-gateway/src/session/collect-output.ts`
- `packages/brewva-gateway/src/session/worker-main.ts`
- `packages/brewva-gateway/src/session/worker-protocol.ts`

## Remaining Backlog

The following questions remain intentionally outside the promoted core:

- whether gateway public session ids should eventually collapse onto runtime
  session ids rather than continuing to use a durable binding layer
- whether future replay use cases justify additional durable committed receipts
  beyond the current turn-level presentation contract
- whether a future `session-wire` revision should promote more live transport
  state into durable committed receipts without widening authority or replay
  noise
- whether a future non-WebSocket transport needs a new wire envelope version or
  can reuse `brewva.session-wire.v2` unchanged

If those areas need expansion, they should start from a new focused RFC rather
than reopening this promoted status pointer as a mixed design-and-rollout note.

## Historical Notes

- Historical option analysis, rollout sequencing, and old-stream comparison
  detail were removed from this file after promotion.
- The stable contract now lives in architecture/reference docs and regression
  coverage rather than in `docs/research/`.
