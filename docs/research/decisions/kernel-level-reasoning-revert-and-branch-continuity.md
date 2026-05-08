# Decision: Kernel-Level Reasoning Revert And Branch Continuity

## Metadata

- Decision: Tape holds branch truth. `reasoning_checkpoint` and `reasoning_revert` are durable source-of-truth receipts for reasoning-branch continuity. Recovery WAL does not own the active branch.
- Date: `2026-04-06`
- Status: accepted
- Stable docs:
  - `docs/architecture/system-architecture.md`
  - `docs/architecture/exploration-and-effect-governance.md`
  - `docs/reference/events/README.md`
  - `docs/reference/runtime.md`
  - `docs/reference/runtime-plugins.md`
  - `docs/reference/session-lifecycle.md`
  - `docs/journeys/internal/context-and-compaction.md`
- Code anchors:
  - `packages/brewva-runtime/src/domain/reasoning/types.ts`
  - `packages/brewva-runtime/src/domain/reasoning/events.ts`
  - `packages/brewva-runtime/src/domain/tape/reasoning-replay.ts`
  - `packages/brewva-runtime/src/domain/reasoning/reasoning.ts`
  - `packages/brewva-runtime/src/events/registry.ts`
  - `packages/brewva-tools/src/families/workflow/reasoning-checkpoint.ts`
  - `packages/brewva-tools/src/families/workflow/reasoning-revert.ts`
  - `packages/brewva-tools/src/families/workflow/tape.ts`

## Decision Summary

- Tape holds branch truth. `reasoning_checkpoint` and `reasoning_revert` are durable source-of-truth receipts for reasoning-branch continuity. Recovery WAL does not own the active branch.
- Replay derives the active lineage. Active reasoning state is reconstructed from append-only branch receipts in a separate replay fold. Off-lineage or malformed revert targets are ignored during replay rather than trusted because they once passed write-time validation.
- Reasoning revert is not world rollback. Reverting a reasoning branch does not roll back files, reset approvals, erase evidence truth, or reset cost truth. Optional linkage to receipt-based mutation rollback remains explicit through `linkedRollbackReceiptIds`.
- Hosted resume is bounded and replay-first. Hosted recovery may rebuild model-visible messages from the surviving branch and continue with `reasoning_revert_resume`, but it does not create a second hidden prompt path or a separate branch-truth authority surface.
- Public reasoning revert provenance is explicit. Public tool calls that omit `trigger` normalize to `operator_request`; `model_self_repair` must be explicit in the durable receipt.

## Superseded by

- None.
