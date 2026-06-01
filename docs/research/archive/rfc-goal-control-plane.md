# RFC: Goal Control Plane

## Document Metadata

- Status: `archived`
- Owner: CLI, gateway, runtime tools, and skills maintainers
- Last reviewed: `2026-06-01`
- Accepted decision: `docs/research/decisions/goal-control-plane.md`
- Promotion target:
  - `docs/reference/commands/interactive.md`
  - `docs/reference/commands/channel.md`
  - `docs/reference/tools.md`
  - `docs/reference/tools/workflow-and-scheduling.md`
  - `docs/reference/skills.md`

## Archive Summary

This RFC proposed promoting `/goal` from an advisory prompt pattern into a
first-class Brewva control plane. The accepted implementation keeps `/goal` as
a built-in shell and channel command backed by hosted runtime ops, event tape,
capability-scoped managed tools, shared parsing, goal continuation lifecycle
handling, and inspect/cockpit projections.

The stable contract now lives in the reference docs and accepted decision above.
This archived note is historical context only and must not be treated as the
normative `/goal` specification.

## Final Decisions

- `/goal` is a built-in control-plane command, not a file-backed slash command
  and not a skill-owned lifecycle.
- Goal state is derived from replay-visible `goal.*` events. The runtime cache
  is only an optimization.
- `cleared` is a lifecycle event that projects to no current goal, not a
  retained current status.
- Current goal statuses are `active`, `paused`, `budget_limited`, `complete`,
  and `blocked`.
- Starting a new goal replaces an unterminated current goal and records
  replacement evidence instead of opening an interactive confirmation branch.
- TUI and channel commands share one parser and the same lifecycle semantics.
- `get_goal` and `update_goal` are model-facing control-plane tools exposed only
  for active goals through capability-scoped runtime ports.
- `update_goal` can mark an active goal `complete` or `blocked`; `blocked`
  requires reason, evidence, and the runtime's repeated-blocker gate.
- Goal usage and budget accounting apply to queued goal-continuation turns, not
  ordinary user turns.
- Reload or session start pauses any active goal instead of silently continuing
  autonomous work.
- `goal-loop` remains an independent advisory skill for bounded repeated
  improvement; it does not own `/goal` lifecycle state.

## Historical Rationale

The motivating distinction was skill versus control plane. A skill can help the
model draft, audit, or execute against an objective, but it cannot reliably own
durable lifecycle, pause/resume/clear authority, budget accounting, dynamic tool
visibility, or recovery behavior after reload. Those responsibilities belong in
runtime and host surfaces.

The accepted design keeps the product lesson from `pi-goal` while mapping it to
Brewva's architecture:

- slash/channel commands are operator veneers
- hosted runtime ops own replay-visible lifecycle truth
- managed tools expose only narrow model actions
- continuation prompts are host-owned and capability-aware
- inspect and cockpit views are rebuildable projections, not truth

## Archived Deviations From Early Drafts

Early drafts considered or mentioned several shapes that are no longer current:

- a retained `cleared` status
- an interactive replacement confirmation branch
- `update_goal` accepting only `complete`
- deferring `blocked` until a later release
- a separate goal-writer skill as part of the first slice
- `docs/reference/extensions.md` as a required stable-doc promotion target

These were superseded by the accepted decision and implemented contract.

## Reading Rule

Read the stable docs and `docs/research/decisions/goal-control-plane.md` first.
Use this archive only for design archaeology. If this note conflicts with code,
stable docs, or the accepted decision, the archive loses.
