# Research: Boundary Policy, Credential Vault, and Exact-Call Loop Guard

## Document Metadata

- Status: `promoted`
- Owner: runtime maintainers
- Last reviewed: `2026-03-28`
- Promotion target:
  - `docs/architecture/exploration-and-effect-governance.md`
  - `docs/reference/configuration.md`
  - `docs/reference/runtime.md`
  - `docs/reference/events.md`
  - `docs/reference/commands.md`

## Promotion Summary

This note is now a promoted status pointer.

The accepted decision is:

- deployment-scoped execution constraints live under
  `security.boundaryPolicy`
- encrypted secret storage and opaque execution-time bindings live under
  `security.credentials`
- exact-call loop protection lives under `security.loopDetection.exactCall`
- the shared runtime gate remains
  `runtime.tools.start(...) -> ToolGateService.authorizeToolCall(...)`
- Brewva does not expose a new `runtime.security.*` public domain or a
  monolithic security kernel service for this work

## Stable References

- `docs/architecture/exploration-and-effect-governance.md`
- `docs/reference/configuration.md`
- `docs/reference/runtime.md`
- `docs/reference/events.md`
- `docs/reference/commands.md`

## Current Implementation Notes

- `docs/reference/configuration.md` defines the active
  `security.boundaryPolicy`, `security.loopDetection.exactCall`, and
  `security.credentials` contract.
- `docs/reference/commands.md` and `docs/guide/cli.md` document
  `brewva credentials` as the operator-facing credential-vault surface.
- Current boundary classification is intentionally narrow: `exec` and
  `browser_open` opt into explicit boundary checks, while other tools stay on
  effect governance unless they add a focused classifier.

## Remaining Backlog

- Future tool-specific boundary classifiers should land as narrow follow-on
  work, not by widening the public runtime surface.
- If Brewva ever needs a broader security architecture shift, open a new
  focused RFC instead of reopening this promoted pointer.
