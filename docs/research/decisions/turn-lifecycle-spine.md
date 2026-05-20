# Decision: Turn Lifecycle Spine

## Metadata

- Decision: `TurnLifecycleSpine` is the internal gate-ordering model for one accepted hosted turn.
- Date: `2026-04-29`
- Status: accepted
- Stable docs:
  - `docs/architecture/system-architecture.md`
  - `docs/architecture/control-and-data-flow.md`
  - `docs/architecture/invariants-and-reliability.md`
  - `docs/reference/session-lifecycle.md`
  - `docs/reference/runtime.md`
  - `docs/reference/events/README.md`
  - `docs/reference/gateway-control-plane-protocol.md`
  - `docs/journeys/internal/context-and-compaction.md`
- Code anchors:
  - `packages/brewva-runtime/src/internal/legacy-runtime/engine/lifecycle/turn-lifecycle-spine.ts`
  - `packages/brewva-gateway/src/hosted/internal/turn-adapter/turn-envelope.ts`
  - Removed hosted turn transition coordinator
  - `test/unit/runtime/turn-lifecycle-spine.unit.test.ts`
  - `test/unit/gateway/turn-envelope.unit.test.ts`

## Decision Summary

- `TurnLifecycleSpine` is the internal gate-ordering model for one accepted hosted turn.
- the stable gate order is `ingress_received -> admission_resolved -> effect_authorized -> execution_recorded -> recovery_settled -> terminal_recorded`.
- the spine is monotonic. Duplicate advancement to the current gate is a no-op; backward advancement or backward recovery supersession is an assertion failure.
- one spine covers one ingress-to-terminal hosted turn. Multiple model/tool iterations inside that turn do not restart the spine.
- hydration folds remain federated but declare the gates they observe.

## Superseded by

- `docs/research/decisions/four-port-runtime-simplification-rfc.md`
