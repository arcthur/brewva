# Decision: Recovery-First Context Governance And History-View Baselines

## Metadata

- Decision: recovery rebuilds model-visible continuity through authority, history-view, working-set, and advisory attention planes without creating a second truth source.
- Date: `2026-06-01`
- Status: accepted
- Stable docs:
  - `docs/architecture/system-architecture.md`
  - `docs/reference/session-lifecycle.md`
  - `docs/reference/hosted-dynamic-context.md`
  - `docs/reference/working-projection.md`
  - `docs/journeys/internal/context-and-compaction.md`
- Code anchors:
  - `packages/brewva-gateway/src/daemon/recovery.ts`
  - `packages/brewva-runtime/src/runtime/tape/impl.ts`
  - `packages/brewva-runtime/src/runtime/model/impl.ts`
  - `packages/brewva-gateway/src/hosted/internal/context/workbench-context.ts`
  - `packages/brewva-gateway/src/hosted/internal/context/evidence/event-stream.ts`
  - `test/contract/runtime/model-materialization.contract.test.ts`
  - `test/unit/gateway/context-materialization.unit.test.ts`

## Decision Summary

- Event tape, checkpoints, reasoning receipts, approval truth, turn receipts, and Recovery WAL remain the authority plane for replay correctness.
- The history-view baseline is a receipt-derived model-history view anchored to `session_compact` or branch reset authority; it is not a new durable event family.
- The recovery working set is a read model for continuation posture, open tool lifecycle, replay guards, blockers, pending outcomes, and resume contracts.
- Recovery order is canonicalize, hydrate authority, rebuild history-view baseline, build working set, and run normal deterministic admission.
- Advisory workbench and recall evidence may inform attention and compaction inputs, but they do not define compact baselines or resume truth.

## Superseded by

- None.
