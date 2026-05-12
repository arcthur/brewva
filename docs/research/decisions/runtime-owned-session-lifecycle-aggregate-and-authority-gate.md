# Decision: Runtime-Owned Session Lifecycle Aggregate And Authority Gate

## Metadata

- Decision: Runtime owns aggregate lifecycle meaning. Tape, receipts, and Recovery WAL remain authority. Lifecycle snapshot is the runtime-owned read model that composes that authority into one posture.
- Date: `2026-04-17`
- Status: accepted
- Stable docs:
  - `docs/architecture/system-architecture.md`
  - `docs/reference/runtime.md`
  - `docs/reference/session-lifecycle.md`
  - `docs/reference/events/README.md`
  - `docs/reference/gateway-control-plane-protocol.md`
- Code anchors:
  - `packages/brewva-runtime/src/domain/sessions/lifecycle.ts`
  - `packages/brewva-runtime/src/domain/lifecycle/session-lifecycle-snapshot.ts`
  - `packages/brewva-runtime/src/runtime/runtime.ts`
  - `packages/brewva-runtime/src/domain/recovery/read-model.ts`
  - `packages/brewva-gateway/src/hosted/internal/session/managed-agent/session.ts`
  - `packages/brewva-gateway/src/daemon/internal/session-wire-status.ts`
  - `packages/brewva-gateway/src/hosted/internal/provider/request/provider-request-reduction.ts`
  - `packages/brewva-gateway/src/hosted/internal/thread-loop/reasoning-revert-recovery.ts`

## Decision Summary

- Runtime owns aggregate lifecycle meaning. Tape, receipts, and Recovery WAL remain authority. Lifecycle snapshot is the runtime-owned read model that composes that authority into one posture.
- Domain reducers stay federated. Hydration folds, approval hydration, recovery posture, hosted transitions, and tooling state continue to own their local rebuild logic.
- Session lifecycle is multi-axis, not flat. `hydration`, `execution`, `recovery`, `skill`, `approval`, `tooling`, `integrity`, and `summary` remain distinct surfaces.
- Adapters consume lifecycle; they do not define it. Gateway `session.status`, provider-request recovery policy, and host bootstrap/reconciliation read lifecycle first and only keep bounded compatibility fallbacks where necessary.
- Host `SessionPhase` remains local. It stays a controller FSM for interaction and UI orchestration, not the authoritative meaning of durable runtime lifecycle.

## Superseded by

- None.
