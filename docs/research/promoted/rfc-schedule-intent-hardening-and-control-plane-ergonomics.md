# Research: Schedule Intent Hardening and Control-Plane Ergonomics

## Document Metadata

- Status: `promoted`
- Owner: runtime/gateway maintainers
- Last reviewed: `2026-04-02`
- Promotion target:
  - `docs/reference/runtime.md`
  - `docs/reference/configuration.md`
  - `docs/reference/events.md`
  - `docs/reference/gateway-control-plane-protocol.md`
  - `docs/reference/tools.md`
  - `docs/reference/commands.md`
  - `docs/journeys/operator/intent-driven-scheduling.md`

## Promotion Summary

This research note is now a promoted status pointer.

The promoted decision is:

- `schedule_intent` events remain the durable source of truth for scheduling
- recurring cron-backed intents persist deterministic forward-jittered
  `nextRunAt` values, and replay treats the event-carried timestamp as
  authoritative
- stale one-shot recovery is deferred by explicit policy rather than always
  firing on catch-up
- gateway exposes explicit `scheduler.pause` and `scheduler.resume`
  incident-control methods
- `follow_up` is the bounded ergonomic wrapper above `schedule_intent`, not a
  separate scheduler subsystem

## Stable References

- `docs/reference/runtime.md`
- `docs/reference/configuration.md`
- `docs/reference/events.md`
- `docs/reference/gateway-control-plane-protocol.md`
- `docs/reference/tools.md`
- `docs/reference/commands.md`
- `docs/journeys/operator/intent-driven-scheduling.md`

## Current Implementation Notes

- `docs/reference/tools.md` and
  `docs/journeys/operator/intent-driven-scheduling.md` document the stable
  relationship between `follow_up` and `schedule_intent`.
- `docs/reference/gateway-control-plane-protocol.md` and
  `docs/reference/commands.md` document the stable `scheduler.pause` /
  `scheduler.resume` surface.
- Stable docs intentionally keep transient daemon-local reminders outside the
  runtime scheduling core.

## Remaining Backlog

- If Brewva later needs transient reminders that intentionally die with the
  daemon, that should start from a new focused RFC adjacent to heartbeat or
  control-plane policy work.
