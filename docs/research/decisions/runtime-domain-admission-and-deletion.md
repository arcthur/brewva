# Decision: Runtime Domain Admission And Deletion

## Metadata

- Decision: Runtime domains exist only when they own replay-bearing receipts or externally consumed runtime ports.
- Date: `2026-05-12`
- Status: accepted
- Stable docs:
  - `docs/architecture/system-architecture.md`
  - `docs/reference/runtime.md`
  - `skills/project/shared/package-boundaries.md`
- Code anchors:
  - `packages/brewva-runtime/src/domain/`
  - `packages/brewva-runtime/src/domain/events/iteration-facts.ts`
  - `packages/brewva-runtime/src/domain/projection/workflow/`
  - `packages/brewva-runtime/src/internal/evidence/`
  - `packages/brewva-runtime/src/evidence.ts`
  - `packages/brewva-runtime/src/runtime/runtime-surfaces.ts`
  - `test/fitness/runtime-domain-migration.fitness.test.ts`
  - `test/fitness/runtime-promoted-architecture.fitness.test.ts`
  - `test/fitness/runtime-workflow-ownership.fitness.test.ts`

## Decision Summary

- A directory under `packages/brewva-runtime/src/domain/<name>/` must own either replay-bearing commitments or externally consumed runtime surface vocabulary.
- Empty domain shells are deleted instead of preserved for future possibility.
- `iteration` is not a runtime domain. Metric and guard fact vocabulary is owned by `events`, which records and queries those facts through the event plane.
- `workflow` is not a runtime domain. Workflow artifact and status derivation is a projection/read-model helper under `domain/projection/workflow/`.
- `evidence` is not a broad runtime domain. Evidence parsing and references live under internal evidence ownership plus the dedicated `@brewva/brewva-runtime/evidence` subpath where needed.
- Domains with no semantic runtime surface must not keep empty `runtime-surface.ts` or `registrar.ts` shells.
- Compatibility with removed domain directories and imports is intentionally not preserved.

## Supersedes

- Domain-admission portions of `docs/research/decisions/runtime-domain-slicing-and-controlled-extension-ports.md`

## Superseded by

- None.
