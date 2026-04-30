# Decision: Boundary Policy, Credential Vault, and Exact-Call Loop Guard

## Metadata

- Decision: deployment-scoped execution constraints live under `security.boundaryPolicy`
- Date: `2026-03-28`
- Status: accepted
- Stable docs:
  - `docs/architecture/exploration-and-effect-governance.md`
  - `docs/reference/configuration.md`
  - `docs/reference/runtime.md`
  - `docs/reference/events/README.md`
  - `docs/reference/commands.md`
- Code anchors:
  - `N/A`

## Decision Summary

- deployment-scoped execution constraints live under `security.boundaryPolicy`
- encrypted secret storage and opaque execution-time bindings live under `security.credentials`
- exact-call loop protection lives under `security.loopDetection.exactCall`
- the shared runtime gate remains `runtime.tools.start(...) -> ToolGateService.authorizeToolCall(...)`
- Brewva does not expose a new `runtime.security.*` public domain or a monolithic security kernel service for this work

## Superseded by

- None.
