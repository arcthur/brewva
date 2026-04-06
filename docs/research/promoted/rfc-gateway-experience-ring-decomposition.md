# Research: Gateway Experience-Ring Decomposition for Channel Host and Context Lifecycle

## Document Metadata

- Status: `promoted`
- Owner: gateway/runtime maintainers
- Last reviewed: `2026-03-29`
- Promotion target:
  - `docs/reference/runtime-plugins.md`
  - `docs/journeys/operator/channel-gateway-and-turn-flow.md`
  - `docs/architecture/control-and-data-flow.md`

## Promotion Summary

This note is now a promoted status pointer.

The accepted decision is:

- hosted session and channel-mode contracts stay behaviorally stable
- `packages/brewva-gateway/src/channels/host.ts` becomes a composition entry
  point instead of the hidden behavior home
- channel-mode orchestration is split into explicit ownership modules, including
  bootstrap, session coordination, session queries, control routing, turn
  dispatch, agent dispatch, and reply writing
- `packages/brewva-gateway/src/runtime-plugins/context-transform.ts` remains a
  lifecycle shell, while hosted compaction control, context injection, and
  telemetry live in narrower adapters

## Stable References

- `docs/reference/runtime-plugins.md`
- `docs/journeys/operator/channel-gateway-and-turn-flow.md`
- `docs/architecture/control-and-data-flow.md`

## Current Implementation Notes

- `docs/journeys/operator/channel-gateway-and-turn-flow.md` now points readers
  at `channel-bootstrap.ts`, `channel-session-coordinator.ts`,
  `channel-control-router.ts`, `channel-turn-dispatcher.ts`,
  `channel-agent-dispatch.ts`, and `channel-reply-writer.ts`.
- `docs/architecture/control-and-data-flow.md` and
  `docs/reference/runtime-plugins.md` define the hosted context split across
  `context-transform.ts`, `hosted-compaction-controller.ts`,
  `hosted-context-injection-pipeline.ts`, and
  `hosted-context-telemetry.ts`.

## Remaining Backlog

- Future transport or hosted-lifecycle contract changes should start from a new
  focused RFC rather than reopening this decomposition pointer.
