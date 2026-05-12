# Archived Research: Gateway Hosted Lane Consolidation RFC

## Document Metadata

- Status: `archived`
- Owner: gateway maintainers
- Last reviewed: `2026-05-12`
- Promotion target:
  - `docs/research/decisions/gateway-hosted-lane-consolidation.md`
  - `docs/architecture/system-architecture.md`
  - `docs/reference/session-lifecycle.md`
  - `docs/reference/extensions.md`
  - `docs/reference/token-cache.md`
  - `skills/project/shared/package-boundaries.md`
  - `skills/project/shared/source-map.md`
- Archived on: `2026-05-12`
- Superseded by:
  - `docs/research/decisions/gateway-hosted-lane-consolidation.md`
  - `docs/architecture/system-architecture.md`
  - `docs/reference/session-lifecycle.md`
  - `docs/reference/extensions.md`
  - `docs/reference/token-cache.md`
  - `skills/project/shared/package-boundaries.md`
  - `skills/project/shared/source-map.md`

## Archive Summary

This RFC drove the destructive consolidation of gateway's hosted execution path.
The implemented shape deleted the old `host/`, `session/`, and
`runtime-plugins/` source families, replaced the public runtime-plugin seam with
`extensions/`, and moved default hosted behavior under the hosted session and
thread-loop owner paths.

It is archived because the accepted contract is now carried by stable docs,
code, quality tests, and the gateway hosted-lane decision. The still-relevant
outcome is:

- hosted session and turn execution enter through `@brewva/brewva-gateway/hosted`
- opt-in host extensions enter through `@brewva/brewva-gateway/extensions`
- default hosted behavior is not modeled as a plugin ecosystem
- hosted side effects are owned by declared implementation paths and guarded by
  quality tests
- old hosted package subpaths are not compatibility aliases

The RFC's remaining service-seam and substrate-naming questions were resolved
in the accepted decision as private implementation carry-over, not active
architecture gaps.

Read current stable docs and code first. Use this archived note only for
historical context on why the hosted lane deleted the plugin-family shape
instead of adding stronger rules around it.
