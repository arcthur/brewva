# Decision: Crash-Safe Durable Substrate For Tape And Recovery WAL

## Metadata

- Decision: The event tape and Recovery WAL survive the crash they exist to recover from — durable writes are the commit point, full-file rewrites are atomic, boundaries are `fsync`'d, a torn trailing line is repaired on load, and the durable-transient WAL quarantines a malformed row instead of failing closed.
- Date: `2026-06-23`
- Status: accepted
- Stable docs:
  - `docs/journeys/internal/wal-and-crash-recovery.md`
  - `docs/reference/runtime.md`
  - `docs/reference/artifacts-and-paths.md`
  - `docs/architecture/invariants-and-reliability.md`
- Code anchors:
  - `packages/brewva-std/src/node/fs.ts`
  - `packages/brewva-gateway/src/daemon/recovery.ts`
  - `packages/brewva-runtime/src/runtime/tape/impl.ts`
  - `packages/brewva-vocabulary/src/internal/durability.ts`

## Decision Summary

- Durability is named at two levels (`DURABILITY_LEVELS`): `process_crash` between boundaries (the OS page cache outlives a process or worker kill) and `power_loss` at a boundary — a committed `turn.ended` / `checkpoint.committed` event or a terminal WAL mark is `fsync`'d. Effect delivery is `at_least_once` (`EFFECT_DELIVERY`).
- Durable writes are the commit point: the WAL appends and `fsync`s a row before any in-memory mutation, and the tape persists before `appendEventToMemory`, so a failed write leaves no in-memory ghost a later dedupe could return as accepted.
- Full-file rewrites (WAL compaction) are atomic — `tmp` write + `fsync` + `rename` + parent-directory `fsync` (`rewriteFileAtomic`) — and a torn trailing line is truncated on load (`loadAppendOnly`), closing both the truncated-tail case and the next-append-merging-onto-torn-bytes case.
- One byte-level torn-tail rule and one record grammar serve both readers per log: the strict loader and the read-only forensic scanner (`scanAppendOnly`) cannot drift, so `brewva inspect` observes the logs without repairing them.
- Truth fails closed; durable-transient quarantines: the tape rejects a malformed record (replay authority) while the WAL isolates a malformed row, preserves it through compaction, surfaces it via `brewva inspect`, and keeps recovering the healthy rows. A corrupt watermark snapshot is quarantined too — its value dropped, the high-watermark rebuilt row-derived from the survivors (a lower bound that never skips), cold-starting only when no surviving row carries a sequence.

## Axioms

These obey `docs/architecture/design-axioms.md`:

- `Tape is commitment memory` (axiom 6): the durable write is the commit point, so committed memory is always backed by an `fsync`-reachable record.
- `Graceful degradation beats hidden cleverness` (axiom 8): a crash artifact (torn tail, interrupted rewrite) self-heals and a durable-transient corruption quarantines rather than wedging the daemon; only replay truth fails closed.
- `Recovery is model-native, not kernel choreography` (axiom 10): the substrate provides durable primitives (atomic rewrite, boundary `fsync`, quarantine), not a recovery planner.
- `Kernel contracts admit only correctness-bearing judgments` (axiom 16): the named durability boundary and the row-derived watermark are the correctness-bearing reading of durability. `Truth fails closed; durable-transient quarantines` is the two-log corollary.

## Open follow-ups

- The durable steering inbox and the tree-history / multi-writer fork remain active notes under `docs/research/active/`; the WAL forensic / quarantine signal feeds the inspect-replay WS1 integrity surface rather than duplicating it.
