# Goal Control Plane

- Decision: `/goal` is a built-in Brewva control plane backed by hosted runtime
  ops, event tape, managed goal tools, and shared shell/channel command parsing.
- Date: `2026-06-01`
- Status: accepted
- Stable docs:
  - `docs/reference/commands/interactive.md`
  - `docs/reference/commands/channel.md`
  - `docs/reference/tools.md`
  - `docs/reference/tools/workflow-and-scheduling.md`
  - `docs/reference/skills.md`
- Code anchors:
  - `packages/brewva-vocabulary/src/internal/goal.ts`
  - `packages/brewva-gateway/src/hosted/internal/session/runtime-ops-builders/goal.ts`
  - `packages/brewva-gateway/src/hosted/internal/session/goal-continuation.ts`
  - `packages/brewva-tools/src/families/workflow/goal.ts`
  - `packages/brewva-cli/src/shell/commands/shell-command-registry.ts`
  - `packages/brewva-gateway/src/channels/command/goal.ts`

## Decision Summary

- `/goal` owns persistent operator intent for a session. The runtime records
  `goal.*` lifecycle, usage, continuation, budget, completion, and blocker
  events; `goal.state.get` rebuilds current state from tape and treats clear as
  no current goal.
- Goal usage is observed only for queued goal-continuation turns. Ordinary user
  turns during an active goal do not consume the goal token budget unless they
  are tied to an unobserved `goal.continuation.queued` event.
- The model participates only through capability-scoped `get_goal` and
  `update_goal`. `update_goal` can set `complete` after audit or `blocked` after
  the runtime has observed the same blocker key across three goal turns.
- Interactive and channel `/goal` commands share grammar and semantics. Channel
  commands target the focused agent by default and use the same owner ACL as
  `/update`.
- The `goal-loop` skill stays separate as advisory guidance for bounded repeated
  improvement; it does not own lifecycle state, budgets, continuation delivery,
  or managed tool visibility.

## Non-Goals

This decision does not add scheduled goals, cross-session inheritance,
multi-agent fanout, configurable cadence, or a public runtime root goal port.
