# Archived Research: Gateway Host-First Refactor And Control-Plane Seam Hardening

## Document Metadata

- Status: `archived`
- Owner: gateway maintainers
- Last reviewed: `2026-05-12`
- Promotion target:
  - `docs/research/decisions/gateway-domain-slicing-and-control-plane-ports.md`
  - `docs/research/decisions/gateway-hosted-lane-consolidation.md`
  - `docs/architecture/system-architecture.md`
  - `docs/reference/session-lifecycle.md`
  - `docs/reference/extensions.md`
  - `skills/project/shared/package-boundaries.md`
  - `skills/project/shared/source-map.md`
- Archived on: `2026-05-12`
- Superseded by:
  - `docs/research/decisions/gateway-domain-slicing-and-control-plane-ports.md`
  - `docs/research/decisions/gateway-hosted-lane-consolidation.md`
  - `docs/architecture/system-architecture.md`
  - `docs/reference/session-lifecycle.md`
  - `docs/reference/extensions.md`
  - `skills/project/shared/package-boundaries.md`
  - `skills/project/shared/source-map.md`

## Archive Summary

This note was the infrastructure precursor to hosted-lane consolidation. It
established gateway domain slicing, narrowed public exports, moved control-plane
CLI code under `admin/`, renamed `subagents/` to `delegation/`, and introduced
quality tests for domain templates, cross-domain internal imports, root export
width, typed command unions, lifecycle unions, provider connection ports, and
hosted session phases.

It is archived because the durable parts have been accepted through
`gateway-domain-slicing-and-control-plane-ports` and then refined by
`gateway-hosted-lane-consolidation`. The original target shape still mentioned
`host/`, `session/`, and runtime-plugin family slicing; those are no longer
current architecture after the hosted-lane decision.

Read current stable docs and code first. Use this archived note only for
historical context on why gateway first narrowed its control-plane and package
surfaces before deleting the parallel hosted families.
