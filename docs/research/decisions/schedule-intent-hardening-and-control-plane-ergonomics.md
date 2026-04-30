# Decision: Schedule Intent Hardening and Control-Plane Ergonomics

## Metadata

- Decision: Runtime scheduling is event-sourced, while `follow_up` remains an ergonomic wrapper.
- Date: `2026-04-02`
- Status: accepted
- Stable docs:
  - `docs/reference/runtime.md`
  - `docs/reference/configuration.md`
  - `docs/reference/events/README.md`
  - `docs/reference/gateway-control-plane-protocol.md`
  - `docs/reference/tools.md`
  - `docs/reference/commands.md`
  - `docs/journeys/operator/intent-driven-scheduling.md`
- Code anchors:
  - `N/A`

## Decision Summary

- `schedule_intent` events remain the durable source of truth for scheduling.
- Recurring cron-backed intents persist deterministic forward-jittered `nextRunAt` values, and replay treats the event-carried timestamp as authoritative.
- Stale one-shot recovery is deferred by explicit policy rather than always firing on catch-up.
- Gateway exposes explicit `scheduler.pause` and `scheduler.resume` incident-control methods.
- `follow_up` is the bounded ergonomic wrapper above `schedule_intent`, not a separate scheduler subsystem.

## Superseded by

- None.
