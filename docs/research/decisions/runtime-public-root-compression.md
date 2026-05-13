# Decision: Runtime Public Root Compression

## Metadata

- Decision: `BrewvaRuntime` public root exposes only identity, config, authority, and inspect.
- Date: `2026-05-12`
- Status: accepted
- Stable docs:
  - `docs/architecture/system-architecture.md`
  - `docs/reference/runtime.md`
  - `docs/guide/understanding-runtime-system.md`
- Code anchors:
  - `packages/brewva-runtime/src/runtime/runtime.ts`
  - `packages/brewva-runtime/src/runtime/runtime-api.ts`
  - `packages/brewva-runtime/src/runtime/runtime-facade-state.ts`
  - `packages/brewva-runtime/src/runtime/runtime-surfaces.ts`
  - `packages/brewva-runtime/src/public/index.ts`
  - `test/contract/runtime/runtime-entrypoint-surface.contract.test.ts`
  - `test/contract/runtime/runtime-facades.contract.test.ts`

## Decision Summary

- The raw `BrewvaRuntime` root is no longer an operational bag. It exposes `identity`, readonly `config`, `authority`, and `inspect`.
- `cwd`, `workspaceRoot`, and `agentId` are grouped under `identity` to prevent root width from being mistaken for authority width.
- `operator` is a repo-owned port, not a public root field. Hosted sessions obtain it through `createHostedRuntimePort(...)`; operator products obtain it through `createOperatorRuntimePort(...)`.
- `extensions` is no longer reachable from the raw runtime root. Hosted code obtains hosted extensions from the hosted port, while managed tools obtain only `extensions.tools` from the tool runtime port.
- Runtime extension ports are TypeScript narrowed ports only. They do not carry branded runtime capability tokens or reflective `capabilities` arrays.
- `authority` contains replay-visible commitments. `inspect` contains read-only queries. `operator` contains bounded hosted/operator machinery that should not be available to managed tools.
- Compatibility with old root fields, old `maintain` naming, and old root extension access is intentionally not preserved.

## Supersedes

- Public-root portions of `docs/research/decisions/authority-surface-narrowing-and-runtime-facade-compression.md`
- Public-root portions of `docs/research/decisions/runtime-domain-slicing-and-controlled-extension-ports.md`

## Superseded by

- None.
