# Decision: Durability Taxonomy And Rebuildable Surface Narrowing

## Metadata

- Decision: Durability language is explicit and repository-wide. Persisted runtime surfaces should be classified as `durable source of truth`, `durable transient`, `rebuildable state`, or `cache`.
- Date: `2026-03-27`
- Status: accepted
- Stable docs:
  - `docs/architecture/system-architecture.md`
  - `docs/reference/artifacts-and-paths.md`
  - `docs/reference/events/README.md`
  - `docs/reference/runtime.md`
  - `docs/reference/session-lifecycle.md`
- Code anchors:
  - `packages/brewva-runtime/src/contracts/proposal.ts`
  - `packages/brewva-runtime/src/contracts/governance.ts`
  - `packages/brewva-runtime/src/ledger/evidence-ledger.ts`
  - `packages/brewva-runtime/src/projection/engine.ts`
  - `packages/brewva-runtime/src/services/effect-commitment-desk.ts`
  - `packages/brewva-runtime/src/services/event-pipeline.ts`
  - `packages/brewva-runtime/src/services/reversible-mutation.ts`
  - `packages/brewva-runtime/src/services/session-lifecycle.ts`

## Decision Summary

- Durability language is explicit and repository-wide. Persisted runtime surfaces should be classified as `durable source of truth`, `durable transient`, `rebuildable state`, or `cache`.
- Event tape, checkpoints, receipts, task/truth/schedule intent events, and linked approval outcomes remain `durable source of truth`.
- Turn WAL plus rollback patch/snapshot history remain `durable transient`.
- Working projection, workflow posture, and similar derived inspection surfaces are `rebuildable state`, not replay authority.
- Channel approval screen state and routing hints are `cache`, not approval truth or exact-resume state.

## Superseded by

- None.
