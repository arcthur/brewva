# Decision: Event Stream Consistency And Replay Fidelity

## Metadata

- Decision: major lifecycle, tool, context, verification, cost, and session events remain queryable replay inputs rather than process-local assumptions.
- Date: `2026-06-01`
- Status: accepted
- Stable docs:
  - `docs/architecture/invariants-and-reliability.md`
  - `docs/reference/events/README.md`
  - `docs/reference/events/session.md`
  - `docs/journeys/operator/inspect-replay-and-recovery.md`
- Code anchors:
  - `packages/brewva-runtime/src/runtime/runtime.ts`
  - `packages/brewva-runtime/src/runtime/tape/impl.ts`
  - `packages/brewva-gateway/src/hosted/internal/context/evidence/event-stream.ts`
  - `test/contract/runtime/runtime-turn-loop.contract.test.ts`
  - `test/contract/runtime/canonical-tape.contract.test.ts`

## Decision Summary

- Replay derives state from durable event tape plus bounded recovery material and workspace state, not hidden process-local bookkeeping.
- Event query semantics keep lifecycle transitions discoverable for inspect, replay, troubleshooting, and operator journey documentation.
- Event payload shape changes require explicit event versioning or replay migration folds before they enter derived read models.
- Rebuildable projections and inspect views may summarize events, but they do not become event-tape truth.

## Superseded by

- None.
