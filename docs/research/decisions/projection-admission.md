# Decision: Projection Admission

## Metadata

- Decision: Runtime projection and evidence remain curated owners guarded by admission tests.
- Date: `2026-05-13`
- Status: accepted
- Stable docs:
  - `docs/reference/working-projection.md`
  - `docs/reference/runtime.md`
  - `skills/project/shared/package-boundaries.md`
- Code anchors:
  - `packages/brewva-runtime/src/read-models/projection/`
  - `packages/brewva-vocabulary/src/iteration.ts`
  - `test/fitness/runtime-projection-admission.fitness.test.ts`

## Decision Summary

- Runtime projection remains a curated owner under `packages/brewva-runtime/src/read-models/projection/`.
- New projection files or subdirectories must update the runtime projection admission quality test.
- Projection code and its relative TypeScript dependency closure must not import gateway hosted internals, provider packages, tool families, or runtime root/operator port contracts.
- Workflow artifact, status, and workspace revision derivation stay deterministic and replay-derived.
- Product evidence vocabulary moved out of runtime into curated `@brewva/brewva-vocabulary/*` subpaths.

## Superseded by

- `docs/research/decisions/four-port-runtime-simplification-rfc.md`
