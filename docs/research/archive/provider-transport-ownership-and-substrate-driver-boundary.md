# Archived Research: Provider Transport Ownership And Substrate Driver Boundary

## Document Metadata

- Status: `archived`
- Owner: substrate, provider-core, and gateway maintainers
- Last reviewed: `2026-06-01`
- Promotion target:
  - `docs/architecture/system-architecture.md`
  - `docs/reference/provider-streaming.md`
  - `skills/project/shared/package-boundaries.md`

## Archive Summary

This note is archived because its original `createFetchProviderCompletionDriver`
framing no longer matches the current provider boundary. Provider-core now owns
streaming mechanisms through domain slices, while gateway-hosted execution uses
the provider execution port and substrate keeps provider catalog vocabulary.

Future transport ownership changes should start from the current
provider-core streaming contract and the provider-core consumption matrix,
especially if a new websocket, SSE, or provider-owned transport abstraction
needs a public boundary decision.
