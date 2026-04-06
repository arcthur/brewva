# Research: Session Wire V2 Attempt-Scoped Live Tool Frames

## Document Metadata

- Status: `archived`
- Owner: gateway and runtime maintainers
- Last reviewed: `2026-04-06`
- Promotion target:
  - `docs/reference/gateway-control-plane-protocol.md`
  - `docs/reference/runtime.md`
  - `docs/reference/events.md`
  - `docs/reference/session-lifecycle.md`

## Archive Summary

This focused RFC has been implemented and folded into stable docs plus the
promoted session-wire note.

The lasting decisions were:

- `brewva.session-wire.v2` is the only public session protocol
- live `tool.started`, `tool.progress`, and `tool.finished` are attempt-scoped
  and require `attemptId`
- authoritative tool-attempt binding comes from repo-owned tool lifecycle
  receipts plus hosted turn-attempt state
- replay remains committed-only; standalone durable `tool.finished` is still
  not projected

## Current Contract

Read current behavior from:

- `docs/reference/gateway-control-plane-protocol.md`
- `docs/reference/runtime.md`
- `docs/reference/events.md`
- `docs/reference/session-lifecycle.md`
- `docs/research/promoted/rfc-derived-session-wire-schema-and-frontend-session-protocol.md`

The stable contract now treats live tool frames as inspectable, attempt-aware
session traffic without widening replay truth or durable event projection.

## Why Keep This Note

This archive remains useful when you need the migration rationale for:

- moving from turn-scoped live tool traffic to explicit attempt scoping
- rejecting collector guesswork as the lasting public binding contract
- keeping committed replay semantics narrower than live frontend observability

## Historical Notes

- Option analysis, full proposal text, and narrow migration sequencing were
  removed from the archive-era main file.
- Use git history if you need the original RFC detail or the intermediate v1 to
  v2 transition reasoning.
