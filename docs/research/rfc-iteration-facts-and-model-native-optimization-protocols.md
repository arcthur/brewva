# Research: Iteration Facts And Model-Native Optimization Protocols

## Document Metadata

- Status: `promoted`
- Owner: runtime maintainers
- Last reviewed: `2026-03-22`
- Promotion target:
  - `docs/architecture/design-axioms.md`
  - `docs/architecture/cognitive-product-architecture.md`
  - `docs/architecture/system-architecture.md`
  - `docs/reference/runtime.md`
  - `docs/reference/events.md`
  - `docs/reference/skills.md`
  - `docs/reference/tools.md`
  - `docs/journeys/intent-driven-scheduling.md`

## Promotion Summary

This note is now a short status pointer.

The decision has been promoted: Brewva persists a small set of objective
iteration facts as replayable runtime evidence, but it does not introduce a
`runtime.optimization.*` domain or a runtime-owned optimizer loop.

Stable implementation now includes:

- durable iteration-fact event families for:
  - `iteration_metric_observed`
  - `iteration_guard_recorded`
- typed `runtime.events.*` helpers for recording and listing those fact
  families
- the managed `iteration_fact` tool for model-native protocols
- derived workflow/projection advisory surfaces such as
  `workflow.iteration_metric` and `workflow.iteration_guard`
- audit/replay integration so fact history survives restart and remains
  queryable through the durable event tape

Stable references:

- `docs/architecture/design-axioms.md`
- `docs/architecture/cognitive-product-architecture.md`
- `docs/architecture/system-architecture.md`
- `docs/reference/runtime.md`
- `docs/reference/events.md`
- `docs/reference/skills.md`
- `docs/reference/tools.md`
- `docs/journeys/intent-driven-scheduling.md`

## Stable Contract Summary

The promoted contract is:

1. Brewva is substrate, not optimizer.
2. Runtime may persist only objective iteration evidence:
   metric observations and guard results on the default model-writable surface.
3. Loop strategy remains model-native and may not be hardened into a
   runtime-owned planner.
4. Workflow/projection surfaces may summarize iteration facts, but those
   summaries remain advisory rather than authoritative.
5. Scheduling and watchdog flows may reference iteration facts, but kernel
   authority remains on effects, receipts, replay, rollback, and verification
   evidence.

## Validation Status

Promotion is backed by:

- runtime facade contract coverage for typed iteration-fact APIs
- managed tool contract coverage for `iteration_fact`
- workflow-derivation unit coverage for iteration-fact advisory artifacts
- full repository verification via `bun run check`, `bun test`,
  `bun run test:docs`, and `bun run format:docs:check`

## Remaining Backlog

The following ideas are intentionally not part of the promoted contract:

- a runtime-owned optimizer domain
- planner state or next-step prescription in the kernel
- automatic keep/discard policy in runtime
- model-writable decision/convergence protocol facts without stronger evidence
  boundaries
- richer protocol products built on top of iteration facts

If those areas become priorities, they should start from a new focused RFC
rather than reopening this promoted status pointer.

## Archive Notes

- Historical option analysis, rollout sequencing, and rationale detail were
  removed from this file after promotion.
- The stable contract now lives in architecture/reference/journey docs and in
  the regression test suite rather than in `docs/research/`.
