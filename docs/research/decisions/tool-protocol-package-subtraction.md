# Decision: Tool Protocol Package Subtraction

## Metadata

- Decision: Tool protocol vocabulary belongs to `@brewva/brewva-substrate/tools`, not a standalone workspace package.
- Date: `2026-05-12`
- Status: accepted
- Stable docs:
  - `docs/reference/tools.md`
  - `docs/architecture/system-architecture.md`
  - `skills/project/shared/package-boundaries.md`
- Code anchors:
  - `packages/brewva-substrate/src/tools/protocol.ts`
  - `packages/brewva-substrate/src/tools/api.ts`
  - `packages/brewva-substrate/src/tools/index.ts`
  - `packages/brewva-tools/src/registry/`
  - `packages/brewva-gateway/src/`
  - `packages/brewva-mcp-adapter/src/index.ts`
  - `test/contract/substrate/tool-contract.contract.test.ts`
  - `test/fitness/substrate-domain-slicing.fitness.test.ts`

## Decision Summary

- `JsonSchema`, `ToolDescriptor`, `ToolCatalogEntry`, `ToolCatalog`, execution-trait vocabulary, and tool-catalog helpers are owned by `@brewva/brewva-substrate/tools`.
- The standalone `@brewva/brewva-tool-protocol` workspace package is removed.
- Consumers import tool protocol vocabulary from the substrate tools subpath.
- Root workspace manifests, TypeScript references, package dependencies, and lockfile state must not reference the removed package.
- Quality tests guard against recreating the removed package or import path.
- Compatibility with `@brewva/brewva-tool-protocol` is intentionally not preserved.

## Supersedes

- Tool-protocol ownership assumptions in `docs/research/decisions/substrate-domain-slicing-and-root-surface-compression.md`

## Superseded by

- None.
