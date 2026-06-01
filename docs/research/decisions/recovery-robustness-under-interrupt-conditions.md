# Decision: Recovery Robustness Under Interrupt Conditions

## Metadata

- Decision: interrupted turns recover from event tape, bounded WAL, rollback material, and replay-derived lifecycle state rather than process memory.
- Date: `2026-06-01`
- Status: accepted
- Stable docs:
  - `docs/architecture/invariants-and-reliability.md`
  - `docs/reference/session-lifecycle.md`
  - `docs/reference/events/session.md`
  - `docs/journeys/operator/inspect-replay-and-recovery.md`
- Code anchors:
  - `packages/brewva-gateway/src/daemon/recovery.ts`
  - `packages/brewva-runtime/src/runtime/tape/impl.ts`
  - `packages/brewva-cli/src/index.ts`
  - `test/live/cli/replay-and-persistence.live.test.ts`
  - `test/live/cli/signal-handling.live.test.ts`

## Decision Summary

- Restart determinism is validated from durable artifacts and replay-derived state, not hidden in-memory bookkeeping.
- Recovery canonicalization diagnoses incomplete attempt-local state before hydration folds apply replayed authority state.
- Interrupted-turn recovery stays operator-visible through lifecycle, replay, WAL, and inspect surfaces.
- Recovery docs describe incident-debug ordering without changing rollback, approval, compaction, or provider authority boundaries.

## Superseded by

- None.
