# Research: Recovery Robustness Under Interrupt Conditions

## Document Metadata

- Status: `active`
- Owner: runtime maintainers
- Last reviewed: `2026-04-06`
- Promotion target:
  - `docs/architecture/invariants-and-reliability.md`
  - `docs/reference/session-lifecycle.md`
  - `docs/journeys/operator/inspect-replay-and-recovery.md`

## Problem Statement And Scope Boundaries

Restart and recovery should remain deterministic when turns are interrupted by
signals, crashes, or host restarts.

This note covers:

- recovery data dependencies across lifecycle phases
- replay and WAL interaction during interrupted turns
- operator-visible recovery and debugging flow

This note does not reopen:

- unrelated CLI ergonomics outside recovery behavior
- changes to rollback semantics that are not needed for interrupt handling

## Working Hypotheses

- Recovery invariants should be documented by lifecycle phase rather than left
  implicit in WAL and replay code paths.
- Operators need a stable incident-debug sequence that maps directly to runtime
  artifacts.
- Restart determinism should be validated from durable artifacts, not process
  memory.

## Source Anchors

- Recovery WAL append/recover: `packages/brewva-runtime/src/channels/recovery-wal.ts`
- Tape replay engine: `packages/brewva-runtime/src/tape/replay-engine.ts`
- CLI replay and undo entrypoint: `packages/brewva-cli/src/index.ts`

## Validation Signals

- Replay and persistence scenarios pass in
  `test/live/cli/replay-and-persistence.live.test.ts`
- Signal handling scenarios pass in
  `test/live/cli/signal-handling.live.test.ts`

## Promotion Criteria

- Recovery data dependencies are explicit by lifecycle phase.
- Session-lifecycle reference docs describe interrupted-turn recovery clearly.
- Operator journey docs describe the incident-debug sequence end to end.
