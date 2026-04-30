# Decision: Token Cache Fidelity And Provider Prefix Stability

## Metadata

- Decision: provider token cache is an efficiency plane, not replay authority
- Date: `2026-04-26`
- Status: accepted
- Stable docs:
  - `docs/reference/token-cache.md`
  - `docs/reference/runtime.md`
  - `docs/reference/runtime-plugins.md`
  - `docs/reference/context-composer.md`
  - `docs/reference/configuration.md`
  - `docs/architecture/system-architecture.md`
- Code anchors:
  - `packages/brewva-provider-core/src/cache-policy.ts`
  - `packages/brewva-provider-core/src/providers/payload-metadata.ts`
  - `packages/brewva-agent-engine/src/agent-engine-types.ts`
  - `packages/brewva-agent-engine/src/provider-stream.ts`
  - `packages/brewva-gateway/src/cache/`
  - `packages/brewva-gateway/src/host/managed-agent-session.ts`
  - `packages/brewva-gateway/src/host/hosted-session-bootstrap.ts`
  - `packages/brewva-gateway/src/host/hosted-settings-backend.ts`

## Decision Summary

- provider token cache is an efficiency plane, not replay authority
- hosted sessions carry an object-shaped `cachePolicy`; there is no `cacheRetention` compatibility alias
- provider-specific cache features stay inside provider-core renderers
- gateway owns request fingerprints, cache-break observations, sticky capability latches, session-stable tool schema snapshots, and debug dumps
- runtime exposes provider-cache observations and visible-read state as live, rebuildable inspection surfaces

## Superseded by

- None.
