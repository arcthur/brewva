# Research: Provider Transport Ownership And Substrate Driver Boundary

## Document Metadata

- Status: `active`
- Owner: substrate, provider-core, and gateway maintainers
- Last reviewed: `2026-05-06`
- Promotion target:
  - `docs/architecture/system-architecture.md`
  - `docs/reference/provider-streaming.md`
  - `skills/project/shared/package-boundaries.md`

## Problem Statement

`@brewva/brewva-substrate/provider` currently owns the host-side completion
driver used by hosted sessions to run one low-level turn through provider-core.
That is the right current boundary because the driver is coupled to hosted turn
execution, request auth, and model catalog state.

The line may need to be revisited if provider-core grows first-class transport
abstractions beyond the current fetch-based stream path, such as provider-owned
websocket or SSE transport modules. At that point, the split should preserve:

- provider-core as the authority for provider wire contracts, event
  normalization, cache rendering, and provider-local transport mechanics
- substrate as the execution-plane owner that chooses models, resolves request
  auth, and drives a hosted turn through a provider mechanism
- gateway as the owner of hosted envelope, recovery policy, and profile
  decisions

## Current Posture

No migration is proposed now. Keep `createFetchProviderCompletionDriver` under
`@brewva/brewva-substrate/provider` until provider-core has a concrete
transport abstraction with more than one provider-owned transport shape.

## Promotion Criteria

Promote this note only when provider-core introduces or rejects a durable
transport abstraction. The accepted decision should state whether transport
drivers live in provider-core, substrate, or a split where provider-core owns
wire transports and substrate owns hosted execution adapters.
