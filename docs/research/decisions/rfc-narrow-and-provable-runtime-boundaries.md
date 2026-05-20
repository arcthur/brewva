# Decision: Narrow And Provable Runtime Boundaries

## Metadata

- Decision: Runtime boundaries are narrowed to explicit factory ports and made provable through hosted materialization plans, managed-tool capability inventory, and projection admission tests.
- Date: `2026-05-13`
- Status: accepted
- Stable docs:
  - `docs/architecture/system-architecture.md`
  - `docs/architecture/control-and-data-flow.md`
  - `docs/reference/runtime.md`
  - `docs/reference/extensions.md`
  - `docs/reference/tools.md`
  - `docs/reference/working-projection.md`
  - `skills/project/shared/package-boundaries.md`
- Code anchors:
  - `packages/brewva-runtime/src/runtime/runtime.ts`
  - `packages/brewva-runtime/src/runtime/runtime-api.ts`
  - `packages/brewva-runtime/src/runtime/runtime-effect.ts`
  - `packages/brewva-gateway/src/hosted/internal/context/materialization.ts`
  - `packages/brewva-tools/src/registry/runtime-capability-inventory.ts`
  - `test/fitness/runtime-projection-admission.fitness.test.ts`

## Decision Summary

- Runtime construction uses `createBrewvaRuntime(...)` to return a frozen four-port `BrewvaRuntime` with `tape`, `kernel`, `model`, and `turn`.
- `BrewvaRuntime` has no hidden state, no symbol-based recovery path, no hosted extensions, and no operator port.
- Internal Effect consumers receive the controller handle explicitly from source-owned runtime assembly; public runtime objects cannot recover it.
- Hosted context policy materializes deterministic plans containing model context, ordered effect commands, and audit data before commit interprets side effects.
- Managed tool runtime capabilities are type-derived and checked against a generated static inventory before scoped runtime proxy construction.
- Runtime projection and internal evidence are curated owners with direct and transitive admission tests.

## Accepted Subdecisions

- `docs/research/decisions/runtime-factory-ports.md`
- `docs/research/decisions/hosted-materialization-plan.md`
- `docs/research/decisions/managed-tool-capability-proof.md`
- `docs/research/decisions/projection-admission.md`

## Superseded by

- `docs/research/decisions/four-port-runtime-simplification-rfc.md`
