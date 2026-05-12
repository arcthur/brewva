# Decision: Substrate Turn Loop Internalization

## Metadata

- Decision: The low-level model/tool turn loop is owned by substrate and exposed only through the explicit turn subpath.
- Date: `2026-05-05`
- Status: accepted
- Stable docs:
  - `docs/architecture/system-architecture.md`
  - `docs/reference/session-lifecycle.md`
  - `docs/reference/extensions.md`
  - `docs/reference/token-cache.md`
  - `docs/reference/configuration.md`
- Code anchors:
  - `packages/brewva-substrate/src/turn/`
  - `packages/brewva-substrate/package.json`
  - `packages/brewva-gateway/src/hosted/internal/session/managed-agent/session.ts`
  - `test/unit/substrate/turn/`

## Decision Summary

- `@brewva/brewva-agent-engine` is removed as a workspace package, package dependency, tsconfig reference, and public import path.
- substrate owns the low-level turn loop as execution-plane mechanism under `@brewva/brewva-substrate/turn`.
- the stable public vocabulary is `BrewvaTurnLoop*`, `createBrewvaTurnLoopController`, `runBrewvaTurnLoop`, and the explicit provider-stream adapter exported from the turn subpath.
- provider-core remains the single authority for provider event, cache, and payload contracts; substrate turn consumes `ProviderCachePolicy`, `ProviderCacheRenderResult`, and `ProviderPayloadMetadata` directly.
- gateway owns hosted envelopes, profiles, recovery decisions, and session policy; it directly consumes the substrate turn loop without re-exporting old agent-engine names.
- runtime remains authority/replay focused and does not absorb turn-loop execution mechanics.
- substrate root exports stay narrow; the turn loop is intentionally not added to the root barrel.
- compatibility with the deleted package name, deleted source paths, old factory name, and old `BrewvaAgentEngine*` type names is intentionally not preserved.

## Builds On

- `docs/research/decisions/hosted-thread-loop-and-unified-recovery-decisions.md`
- `docs/research/decisions/interactive-prompt-queue-and-pending-strip.md`
- `docs/research/decisions/provider-core-domain-slicing-and-driver-port-boundaries.md`
- `docs/research/decisions/token-cache-fidelity-and-provider-prefix-stability.md`

## Superseded by

- None.
