# Research: Event Stream Consistency And Replay Fidelity

## Document Metadata

- Status: `active`
- Owner: runtime maintainers
- Last reviewed: `2026-04-06`
- Promotion target:
  - `docs/architecture/invariants-and-reliability.md`
  - `docs/reference/events.md`
  - `docs/journeys/operator/inspect-replay-and-recovery.md`

## Problem Statement And Scope Boundaries

Major lifecycle transitions should remain queryable, and replay should derive
state without hidden process-local assumptions.

This note covers:

- event-level guarantees needed for replay and inspection
- the contract between event production, event query, and replay derivation
- lifecycle transitions that operators must be able to inspect after the fact

This note does not reopen:

- unrelated changes to storage backends
- broader runtime API expansion beyond what the event contract requires

## Working Hypotheses

- Event-level guarantees belong in stable architecture and reference docs rather
  than only in implementation tests.
- Replay should continue to derive state only from durable inputs plus workspace
  state, not from hidden in-memory bookkeeping.
- Query semantics should make major lifecycle transitions discoverable without
  requiring readers to infer intent from event-store internals.

## Source Anchors

- Runtime core wiring: `packages/brewva-runtime/src/runtime.ts`
- Event stream hook: `packages/brewva-gateway/src/runtime-plugins/event-stream.ts`
- Event store and query path: `packages/brewva-runtime/src/events/store.ts`

## Validation Signals

- Replay correctness remains covered in
  `test/contract/runtime/turn-replay-engine-core.contract.test.ts`
- Event query behavior remains covered in
  `test/contract/runtime/tape-event-store.contract.test.ts`

## Promotion Criteria

- Event-level guarantees are explicit in architecture invariants.
- Replay and query semantics are explicit in reference docs.
- Operator troubleshooting docs can describe event-driven inspection without
  hidden assumptions.
