# Decision: Runtime Public Root Compression

## Metadata

- Decision: The runtime root exposes only identity, config, tape, kernel, model, start, turn, and close.
- Date: `2026-05-12`
- Status: accepted
- Stable docs:
  - `docs/architecture/system-architecture.md`
  - `docs/reference/runtime.md`
  - `docs/guide/understanding-runtime-system.md`
- Code anchors:
  - `packages/brewva-runtime/src/runtime/runtime.ts`
  - `packages/brewva-runtime/src/runtime/runtime-api.ts`
  - `packages/brewva-runtime/src/internal/runtime-state.ts`
  - `packages/brewva-runtime/src/internal/runtime-ops.ts`
  - `packages/brewva-runtime/src/public/index.ts`
  - `test/contract/runtime/runtime-entrypoint-surface.contract.test.ts`
  - `test/contract/runtime/runtime-facades.contract.test.ts`

## Decision Summary

- The runtime root is no longer an operational bag. It exposes the four-port runtime contract: `identity`, readonly `config`, `tape`, `kernel`, `model`, `start`, `turn`, and `close`.
- `cwd`, `workspaceRoot`, and `agentId` are grouped under `identity` to prevent root width from being mistaken for authority width.
- `operator` is a CLI experience concern, not a public runtime root field. Hosted sessions that still need implementation-adjacent machinery obtain it through the gateway-owned `ops` adapter.
- `extensions` is no longer reachable from the raw runtime root. Hosted code obtains hosted extensions from the gateway adapter, while managed tools use runtime-bound capability ports.
- Runtime extension ports are TypeScript narrowed adapter ports only. They do not carry branded runtime capability tokens or reflective `capabilities` arrays.
- `tape` contains replay-visible facts. `kernel` contains consequence authorization. `model` contains attention materialization. `turn` contains provider, retry, budget, interruption, and terminal commit physics.
- Compatibility with old root fields, old `maintain` naming, and old root extension access is intentionally not preserved.

## Supersedes

- Public-root portions of `docs/research/decisions/authority-surface-narrowing-and-runtime-facade-compression.md`
- Public-root portions of `docs/research/decisions/runtime-domain-slicing-and-controlled-extension-ports.md`

## Superseded by

- `docs/research/decisions/four-port-runtime-simplification-rfc.md`
