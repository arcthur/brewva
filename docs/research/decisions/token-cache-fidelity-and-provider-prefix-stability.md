# Decision: Token Cache Fidelity And Provider Prefix Stability

## Metadata

- Decision: provider token cache is an efficiency plane, not replay authority
- Date: `2026-04-26`
- Status: accepted
- Stable docs:
  - `docs/reference/token-cache.md`
  - `docs/reference/runtime.md`
  - `docs/reference/extensions.md`
  - `docs/reference/hosted-dynamic-context.md`
  - `docs/reference/configuration.md`
  - `docs/architecture/system-architecture.md`
- Code anchors:
  - `packages/brewva-provider-core/src/cache/policy.ts`
  - `packages/brewva-provider-core/src/cache/capability.ts`
  - `packages/brewva-provider-core/src/cache/render/`
  - `packages/brewva-provider-core/src/providers/_shared/payload-metadata.ts`
  - `packages/brewva-substrate/src/turn/types.ts`
  - `packages/brewva-substrate/src/turn/provider-stream.ts`
  - `packages/brewva-gateway/src/hosted/internal/provider/cache/`
  - `packages/brewva-gateway/src/hosted/internal/session/managed-agent/session.ts`
  - `packages/brewva-gateway/src/hosted/internal/session/init/session-assembly.ts`
  - `packages/brewva-gateway/src/hosted/internal/session/settings/hosted-settings-backend.ts`

## Decision Summary

- provider token cache is an efficiency plane, not replay authority
- hosted sessions carry an object-shaped `cachePolicy`; there is no `cacheRetention` compatibility alias
- provider-specific cache features stay inside provider-core renderers
- gateway owns request fingerprints, cache-break observations, sticky capability latches, session-stable tool schema snapshots, and debug dumps
- runtime exposes provider-cache observations and visible-read state as live, rebuildable inspection surfaces

## Superseded by

- None.
