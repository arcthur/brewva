# Decision: Provider-Core Domain Slicing And Driver Port Boundaries

## Metadata

- Decision: provider-core owns typed provider mechanisms through domain slices and a session lifecycle port
- Date: `2026-05-05`
- Status: accepted
- Stable docs:
  - `docs/architecture/system-architecture.md`
  - `docs/reference/provider-streaming.md`
  - `docs/reference/token-cache.md`
  - `skills/project/shared/package-boundaries.md`
  - `skills/project/shared/anti-patterns.md`
- Code anchors:
  - `packages/brewva-provider-core/src/contracts/`
  - `packages/brewva-provider-core/src/catalog/`
  - `packages/brewva-provider-core/src/registry/`
  - `packages/brewva-provider-core/src/stream/`
  - `packages/brewva-provider-core/src/parse/`
  - `packages/brewva-provider-core/src/cache/`
  - `packages/brewva-provider-core/src/providers/`
  - `packages/brewva-substrate/src/turn/types.ts`
  - `packages/brewva-gateway/src/hosted/internal/session/managed-agent/session.ts`

## Decision Summary

- Provider-core is a mechanism package below gateway and runtime authority. It owns provider contracts, model catalog lookup, provider registration, stream normalization, parse-advisory helpers, cache rendering, and driver adapters; it does not own replay, WAL, credentials authority, or hosted session policy.
- The package implementation is physically sliced by domain: `contracts/`, `catalog/`, `registry/`, `stream/`, `parse/`, `cache/`, `auth/`, and vertical `providers/<api>/` folders. Shared provider helpers live under `providers/_shared/`; mixed root implementation files are not part of the accepted shape.
- Provider events have one canonical contract in provider-core. The substrate turn loop derives its assistant event union from that contract instead of redeclaring provider event families, so advisory fields such as `parseStatus` cannot drift across package boundaries.
- The typed provider registry owns api-id to option-shape binding through `ProviderOptionsByApi`, lazy built-in registration, and the `ProviderSessionResources` lifecycle port. `clearSession(sessionId)` may be synchronous or asynchronous, and hosted callers that replace session context or change provider/model must await it before continuing.
- Provider token-cache behavior stays in the efficiency plane. Provider-core owns provider-neutral cache policy/capability contracts and per-provider renderers under `cache/render/`; gateway owns request fingerprints, cache-break observations, sticky latches, and session-scoped cleanup orchestration.
- Provider SDK payload narrowing is bounded to driver wire seams. Compatibility casts should be local to `providers/<api>/wire.ts`-style modules or equivalent adapter boundaries, not scattered through business logic.
- The root export remains a compatibility surface locked by an export snapshot. Any later public-root narrowing is a separate decision with explicit subpath migration and dist-safety validation.

## Superseded by

- None.
