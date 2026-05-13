# Decision: Runtime Factory Ports

## Metadata

- Decision: Runtime construction returns explicit frozen ports instead of a public facade class or root-reflective helpers.
- Date: `2026-05-13`
- Status: accepted
- Stable docs:
  - `docs/reference/runtime.md`
  - `docs/reference/extensions.md`
  - `docs/architecture/system-architecture.md`
  - `docs/architecture/control-and-data-flow.md`
- Code anchors:
  - `packages/brewva-runtime/src/runtime/runtime.ts`
  - `packages/brewva-runtime/src/runtime/runtime-api.ts`
  - `packages/brewva-runtime/src/runtime/runtime-effect.ts`

## Decision Summary

- `createBrewvaRuntime(...)` returns a frozen `BrewvaRuntimeInstance` with explicit `root`, `hosted`, `tool`, and `operator` ports.
- `BrewvaRuntimeRoot` contains only `identity`, `config`, `authority`, and `inspect`.
- The root has no hidden symbol and cannot recover hosted extensions, tool extensions, operator access, or the internal Effect spine.
- Internal Effect consumers receive the controller handle explicitly from the source-owned runtime assembly factory; no module recovers a controller from a public runtime instance.
- Operator products use `selectOperatorRuntimePort(instance)`.
- Hosted composition roots may hold the full instance briefly, while leaf modules receive only their required port.

## Superseded by

- None.
