# Decision: Rollback Ergonomics And Patch Lifecycle Safety

## Metadata

- Decision: rollback is a receipt-aware lifecycle over tracked mutations, not a generic undo promise.
- Date: `2026-06-01`
- Status: accepted
- Stable docs:
  - `docs/architecture/invariants-and-reliability.md`
  - `docs/journeys/operator/approval-and-rollback.md`
  - `docs/reference/tools.md`
  - `docs/reference/events/tools.md`
- Code anchors:
  - `packages/brewva-vocabulary/src/workbench.ts`
  - `packages/brewva-runtime/src/runtime/runtime.ts`
  - `packages/brewva-runtime/src/runtime/kernel/impl.ts`
  - `packages/brewva-tools/src/families/workflow/rollback-last-patch.ts`
  - `test/live/cli/undo.live.test.ts`
  - `test/unit/tools/runtime-capability-scope.unit.test.ts`

## Decision Summary

- Rollback restores only tracked mutations for the target session and resets stale verification assumptions.
- Patch lifecycle evidence links mutation receipts, `PatchSet` rollback material, rollback events, and redo/rewind inspection.
- `rollback_last_patch` and runtime rollback APIs return explicit no-candidate or failure states instead of implying universal undo coverage.
- History-rewriting Git workflows stay outside runtime rollback semantics.

## Superseded by

- None.
