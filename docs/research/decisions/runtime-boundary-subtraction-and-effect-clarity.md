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
  - `packages/brewva-runtime/src/runtime/runtime-surfaces.ts`
  - `packages/brewva-runtime/src/runtime/wiring.ts`
  - `packages/brewva-runtime/src/domain/events/iteration-controller.ts`
  - `packages/brewva-gateway/src/hosted/internal/context/materialization.ts`
  - `packages/brewva-gateway/src/hosted/internal/compaction/model-downshift-policy.ts`
  - `packages/brewva-substrate/src/tools/protocol.ts`
  - `packages/brewva-tools/src/registry/managed-metadata.ts`
  - `script/generate-doc-inventory.ts`
  - `test/quality/runtime-promoted-architecture.quality.test.ts`
  - `test/quality/gateway/hosted-lane-layout.quality.test.ts`

## Decision Summary

- Runtime authority is commit-bearing, runtime inspection is read-only, and hosted/operator mechanisms are repo-owned ports rather than public root fields.
- `BrewvaRuntimeRoot` exposes only `identity`, readonly `config`, `authority`, and `inspect`; `maintain`, root extension access, hidden state, and identity scalar root fields are removed.
- Runtime domains must own replay-bearing commitments or externally consumed runtime surface vocabulary; empty or mechanism-only domains are deleted or rehomed under their real owner.
- Runtime surface assembly is explicit. Surviving domains expose direct surface constructors and `runtime-surfaces.ts` assembles ordered `authority`, `inspect`, and `operator` objects without descriptor glue.
- Runtime composition is a flat wiring root organized by identity, durability, eager commitment services, lazy mechanisms, ports, and operator/internal services.
- Hosted context materialization plans ordered effect commands before committing them, and the plan order is a tested invariant.
- Tool protocol vocabulary is owned by `@brewva/brewva-substrate/tools`; managed tool runtime capabilities are single-sourced from the registry.
- Runtime reference inventory enforces the public surface budget, including the separate inspection-method budget.

## Supersedes

- Runtime-boundary portions of `docs/research/decisions/runtime-domain-slicing-and-controlled-extension-ports.md`
- Runtime-root portions of `docs/research/decisions/authority-surface-narrowing-and-runtime-facade-compression.md`
- Tool-protocol ownership assumptions in `docs/research/decisions/substrate-domain-slicing-and-root-surface-compression.md`

## Superseded by

- `docs/research/decisions/runtime-factory-ports.md`
- `docs/research/decisions/hosted-materialization-plan.md`
