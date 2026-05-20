# Decision: Substrate Turn Loop Internalization

## Metadata

- Decision: The low-level model/tool turn loop was owned by substrate and exposed only through the explicit turn subpath.
- Date: `2026-05-05`
- Status: accepted
- Stable docs:
  - `docs/architecture/system-architecture.md`
  - `docs/reference/session-lifecycle.md`
  - `docs/reference/extensions.md`
  - `docs/reference/token-cache.md`
  - `docs/reference/configuration.md`
- Code anchors:
  - `packages/brewva-substrate/src/agent-protocol/`
  - `packages/brewva-substrate/package.json`
  - `packages/brewva-gateway/src/hosted/internal/session/managed-agent/session.ts`
  - `packages/brewva-runtime/src/runtime/engine/turn.ts`

## Decision Summary

- `@brewva/brewva-agent-engine` is removed as a workspace package, package dependency, tsconfig reference, and public import path.
- substrate no longer owns the turn loop. `@brewva/brewva-substrate/agent-protocol` only carries message vocabulary used by legacy hosted transcript adapters.
- `createBrewvaAgentProtocolController` and `runBrewvaAgentProtocol` were removed; `runtime.turn(...)` is the only model/tool turn owner.
- provider-core remains the single authority for provider event, cache, and payload contracts; substrate turn consumes `ProviderCachePolicy`, `ProviderCacheRenderResult`, and `ProviderPayloadMetadata` directly.
- gateway owns hosted envelopes, profiles, and transport mapping; it delegates turn execution to runtime.
- runtime owns replay, physics, provider streaming, tool transactions, and turn execution mechanics.
- substrate root exports stay narrow; there is no substrate turn-owner export.
- compatibility with the deleted package name, deleted source paths, old factory name, and old `BrewvaAgentEngine*` type names is intentionally not preserved.

## Builds On

- `docs/research/decisions/hosted-turn-adapter-and-unified-recovery-decisions.md`
- `docs/research/decisions/interactive-prompt-queue-and-pending-strip.md`
- `docs/research/decisions/provider-core-domain-slicing-and-driver-port-boundaries.md`
- `docs/research/decisions/token-cache-fidelity-and-provider-prefix-stability.md`

## Superseded by

- `docs/research/decisions/four-port-runtime-simplification-rfc.md`
