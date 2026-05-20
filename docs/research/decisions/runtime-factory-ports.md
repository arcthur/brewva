# Decision: Runtime Factory Ports

## Metadata

- Decision: Runtime construction returns the four-port runtime root instead of a public facade class or root-reflective helpers.
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

- `createBrewvaRuntime(...)` returns a frozen `BrewvaRuntime` with `identity`, `config`, `tape`, `kernel`, `model`, `start`, `turn`, and `close`.
- The root has no hidden symbol and cannot recover hosted extensions, tool extensions, operator access, or the internal Effect spine.
- Internal Effect consumers receive the controller handle explicitly from the source-owned runtime assembly factory; no module recovers a controller from a public runtime object.
- Gateway hosted composition may construct a temporary adapter from the internal runtime assembly, while leaf modules receive only their required port.
- The runtime assembly no longer constructs compatibility runtime instances; adapter instance construction belongs to gateway/test boundaries.

## Superseded by

- `docs/research/decisions/four-port-runtime-simplification-rfc.md`
