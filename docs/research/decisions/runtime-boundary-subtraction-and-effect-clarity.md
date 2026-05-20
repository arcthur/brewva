# Decision: Runtime Boundary Subtraction And Effect Clarity

## Metadata

- Decision: Runtime, gateway, substrate, and tools boundaries are simplified around explicit authority, inspection, and hosted operator ownership.
- Date: `2026-05-13`
- Status: accepted
- Stable docs:
  - `docs/architecture/system-architecture.md`
  - `docs/architecture/control-and-data-flow.md`
  - `docs/reference/runtime.md`
  - `docs/reference/extensions.md`
  - `docs/reference/tools.md`
  - `skills/project/shared/package-boundaries.md`
- Code anchors:
  - `packages/brewva-runtime/src/runtime/runtime.ts`
  - `packages/brewva-runtime/src/runtime/runtime-api.ts`
  - `packages/brewva-runtime/src/internal/runtime-ops.ts`
  - `packages/brewva-runtime/src/runtime/wiring.ts`
  - `packages/brewva-runtime/src/internal/legacy-runtime/tape/event-ops/iteration-controller.ts`
  - `packages/brewva-gateway/src/hosted/internal/context/materialization.ts`
  - `packages/brewva-gateway/src/hosted/internal/compaction/model-downshift-policy.ts`
  - `packages/brewva-substrate/src/tools/protocol.ts`
  - `packages/brewva-tools/src/registry/managed-metadata.ts`
  - `script/generate-doc-inventory.ts`
  - `test/fitness/runtime-promoted-architecture.fitness.test.ts`
  - `test/fitness/gateway/hosted-lane-layout.fitness.test.ts`

## Supersession Note

This decision is historical. The four-port runtime cutover removed the public
`authority` / `inspect` root and replaced gateway-owned turn recovery with
`runtime.turn(...)` plus canonical tape projections. Do not use this document as
implementation guidance.

## Decision Summary

- Runtime authority and inspection were previously split into semantic root
  surfaces. The four-port runtime cutover supersedes that design with canonical
  Tape projections, Kernel tool transactions, Model attention, and
  `runtime.turn(...)`.
- The old `runtime-ops.ts` compatibility plane remains a quarantined internal
  adapter while repo-owned consumers migrate, but it is not a public root or a
  model for new implementation.
- Hosted context and gateway transport code must call `runtime.turn(...)` and
  consume Tape projections instead of owning turn truth or recovery policy.
- Tool protocol vocabulary remains owned by `@brewva/brewva-substrate/tools`;
  managed tool runtime capabilities are single-sourced from the registry.

## Supersedes

- Runtime-boundary portions of `docs/research/decisions/runtime-domain-slicing-and-controlled-extension-ports.md`
- Runtime-root portions of `docs/research/decisions/authority-surface-narrowing-and-runtime-facade-compression.md`
- Tool-protocol ownership assumptions in `docs/research/decisions/substrate-domain-slicing-and-root-surface-compression.md`

## Superseded by

- `docs/research/decisions/runtime-factory-ports.md`
- `docs/research/decisions/hosted-materialization-plan.md`
- `docs/research/decisions/four-port-runtime-simplification-rfc.md`
