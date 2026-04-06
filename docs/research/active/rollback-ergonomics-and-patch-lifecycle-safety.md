# Research: Rollback Ergonomics And Patch Lifecycle Safety

## Document Metadata

- Status: `active`
- Owner: runtime maintainers
- Last reviewed: `2026-04-06`
- Promotion target:
  - `docs/architecture/invariants-and-reliability.md`
  - `docs/journeys/operator/approval-and-rollback.md`
  - `docs/reference/tools.md`

## Problem Statement And Scope Boundaries

Rollback behavior should stay predictable and explicitly bounded to tracked
mutations.

This note covers:

- rollback safety guarantees and tracked-mutation boundaries
- runtime rollback wiring and operator-visible tool behavior
- patch lifecycle expectations from mutation to undo

This note does not reopen:

- unrelated mutation tooling outside rollback safety
- history-rewriting workflows that are out of scope for runtime rollback

## Working Hypotheses

- Architecture docs should state rollback invariants directly rather than
  relying on tool behavior to imply them.
- Operator journey docs should make rollback expectations and failure cases
  explicit.
- Tool docs should describe rollback as a bounded, receipt-aware lifecycle
  instead of a generic undo promise.

## Source Anchors

- Rollback tracking state: `packages/brewva-runtime/src/state/file-change-tracker.ts`
- Runtime rollback wiring: `packages/brewva-runtime/src/runtime.ts`
- Rollback tool contract: `packages/brewva-tools/src/rollback-last-patch.ts`

## Validation Signals

- Rollback behavior remains covered in `test/live/cli/undo.live.test.ts`
- Tool flow contract remains covered in
  `test/contract/tools/rollback.contract.test.ts`

## Promotion Criteria

- Rollback safety guarantees are reflected in architecture invariants.
- Tool-level rollback contract is explicit in reference docs.
- Operator docs describe rollback limits and expected lifecycle transitions.
