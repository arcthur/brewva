# Decision: Gateway Experience-Ring Decomposition for Channel Host and Context Lifecycle

## Metadata

- Decision: hosted session and channel-mode contracts stay behaviorally stable
- Date: `2026-03-29`
- Status: accepted
- Stable docs:
  - `docs/reference/extensions.md`
  - `docs/journeys/operator/channel-gateway-and-turn-flow.md`
  - `docs/architecture/control-and-data-flow.md`
- Code anchors:
  - `packages/brewva-gateway/src/channels/host.ts`
  - `packages/brewva-gateway/src/hosted/internal/context/context-transform.ts`

## Decision Summary

- hosted session and channel-mode contracts stay behaviorally stable
- `packages/brewva-gateway/src/channels/host.ts` becomes a composition entry point instead of the hidden behavior home
- channel-mode orchestration is split into explicit ownership modules, including bootstrap, session coordination, session queries, control routing, turn dispatch, agent dispatch, and reply writing
- `packages/brewva-gateway/src/hosted/internal/context/context-transform.ts` remains a lifecycle shell, while hosted compaction control, context injection, and telemetry live in narrower adapters
- The accepted decision is:

## Superseded by

- None.
