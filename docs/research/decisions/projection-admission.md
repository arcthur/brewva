# Decision: Projection Admission

## Metadata

- Decision: Runtime projection and internal evidence remain curated owners guarded by admission tests.
- Date: `2026-05-13`
- Status: accepted
- Stable docs:
  - `docs/reference/working-projection.md`
  - `docs/reference/runtime.md`
  - `skills/project/shared/package-boundaries.md`
- Code anchors:
  - `packages/brewva-runtime/src/domain/projection/`
  - `packages/brewva-runtime/src/internal/evidence/api.ts`
  - `test/quality/runtime-projection-admission.quality.test.ts`

## Decision Summary

- Runtime projection remains a curated owner under `packages/brewva-runtime/src/domain/projection/`.
- New projection files or subdirectories must update the runtime projection admission quality test.
- Projection code and its relative TypeScript dependency closure must not import gateway hosted internals, provider packages, tool families, or runtime root/operator port contracts.
- Workflow artifact, status, and workspace revision derivation stay deterministic and replay-derived.
- `packages/brewva-runtime/src/internal/evidence/` remains a curated evidence vocabulary owner, not a generic internal helper drawer.

## Superseded by

- None.
