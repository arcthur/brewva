# Decision: Runtime Domain Slicing And Controlled Extension Ports

## Metadata

- Decision: Runtime implementation ownership is sliced by domain and repo-owned escape hatches are explicit controlled extension ports
- Date: `2026-05-01`
- Status: accepted
- Stable docs:
  - `docs/architecture/system-architecture.md`
  - `docs/reference/runtime.md`
  - `docs/reference/extensions.md`
  - `docs/reference/events/README.md`
  - `docs/guide/understanding-runtime-system.md`
- Code anchors:
  - `packages/brewva-runtime/src/domain/`
  - `packages/brewva-runtime/src/runtime/runtime-composition.ts`
  - `packages/brewva-runtime/src/runtime/runtime-surfaces.ts`
  - `packages/brewva-runtime/src/runtime/runtime-extensions.ts`
  - `packages/brewva-runtime/src/public/index.ts`
  - `packages/brewva-runtime/package.json`

## Decision Summary

- runtime package implementation ownership follows domain slices under `domain/<name>/`, with explicit `api.ts`, `types.ts`, `registrar.ts`, and `runtime-surface.ts` seams
- `BrewvaRuntime` keeps the semantic root contract: `authority`, `inspect`, and `maintain`
- method groups, broad assembler layers, the root `internal` entrypoint, and production implementation barrels are removed as integration surfaces
- runtime assembly is owned by a typed composition root, domain registrars, and domain-owned runtime surface descriptors
- repo-owned code that needs implementation-adjacent capability uses branded controlled extension ports or dedicated explicit subpaths, not a catch-all internal barrel
- controlled ports are sealed so their object shape cannot expand while existing method slots remain compatible with proxy wrappers and targeted test replacement
- registered typed event descriptors are the shared append/read/replay schema boundary; malformed registered typed payloads are rejected before entering the tape
- compatibility with former source paths, method-group names, or `/internal` imports is intentionally not preserved

## Superseded by

- None.
