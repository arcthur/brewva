# Research: Durability Taxonomy And Rebuildable Surface Narrowing

## Document Metadata

- Status: `promoted`
- Owner: runtime maintainers
- Last reviewed: `2026-03-27`
- Promotion target:
  - `docs/architecture/system-architecture.md`
  - `docs/reference/artifacts-and-paths.md`
  - `docs/reference/events.md`
  - `docs/reference/runtime.md`
  - `docs/reference/session-lifecycle.md`

## Promotion Summary

This research note is now a promoted status pointer.

The promoted decision is:

- Brewva uses an explicit four-class durability taxonomy for persisted runtime
  surfaces:
  - `durable source of truth`
  - `durable transient`
  - `rebuildable state`
  - `cache`
- advisory, explicit-pull, and deterministically reconstructable surfaces must
  not be treated as replay-critical state
- helper persistence may exist, but it must not silently become authority or
  recovery truth

Stable implementation now includes:

- effect-commitment-only proposal admission and replay-first approval truth
- turn WAL and rollback material narrowed as bounded recovery state
- working projection and workflow posture treated as rebuildable derived state
- channel approval helper material reduced to process-local cache rather than a
  durable recovery contract
- evidence ledger integrity wording narrowed to local coherence rather than
  anti-tamper security

Stable references:

- `docs/architecture/system-architecture.md`
- `docs/reference/artifacts-and-paths.md`
- `docs/reference/events.md`
- `docs/reference/runtime.md`
- `docs/reference/session-lifecycle.md`

## Stable Contract Summary

The promoted contract is:

1. Durability language is explicit and repository-wide.
   Persisted runtime surfaces should be classified as `durable source of
truth`, `durable transient`, `rebuildable state`, or `cache`.
2. Event tape, checkpoints, receipts, task/truth/schedule intent events, and
   linked approval outcomes remain `durable source of truth`.
3. Turn WAL plus rollback patch/snapshot history remain `durable transient`.
4. Working projection, workflow posture, and similar derived inspection
   surfaces are `rebuildable state`, not replay authority.
5. Channel approval screen state and routing hints are `cache`, not approval
   truth or exact-resume state.
6. Local evidence-ledger integrity checks validate row coherence only; they do
   not claim distributed or anti-tamper security properties.

## Validation Status

Promotion is backed by:

- projection rebuild coverage when on-disk projection artifacts are removed
- replay and restart coverage for approval requests, approval decisions, and
  linked tool outcomes without hidden channel-side durable state
- scheduler recovery coverage anchored to schedule intent events and turn WAL
- rollback coverage narrowed to receipt-backed rollbackable mutation flows
- docs and runtime contracts that distinguish authoritative, rebuildable, and
  cache-only surfaces consistently

## Source Anchors

- `packages/brewva-runtime/src/contracts/proposal.ts`
- `packages/brewva-runtime/src/contracts/governance.ts`
- `packages/brewva-runtime/src/ledger/evidence-ledger.ts`
- `packages/brewva-runtime/src/projection/engine.ts`
- `packages/brewva-runtime/src/services/effect-commitment-desk.ts`
- `packages/brewva-runtime/src/services/event-pipeline.ts`
- `packages/brewva-runtime/src/services/reversible-mutation.ts`
- `packages/brewva-runtime/src/services/session-lifecycle.ts`
- `packages/brewva-runtime/src/channels/recovery-wal.ts`
- `packages/brewva-gateway/src/channels/host.ts`
- `packages/brewva-channels-telegram/src/adapter.ts`
- `packages/brewva-channels-telegram/src/projector.ts`

## Remaining Backlog

The following questions remain intentionally outside the promoted core:

- whether evidence-ledger rows should remain durable long term or become a
  rebuildable query product
- which scheduler helper surfaces deserve persistence once schedule taxonomy is
  documented more explicitly
- whether the public proposal contract still has further simplification
  headroom beyond the current effect-commitment-only shape

If those areas need expansion, they should start from a new focused RFC rather
than reopening this promoted status pointer as a mixed design-and-rollout note.

## Historical Notes

- historical option analysis and rollout detail were removed from this file
  after promotion
- the stable contract now lives in architecture/reference docs and regression
  tests rather than in `docs/research/`
