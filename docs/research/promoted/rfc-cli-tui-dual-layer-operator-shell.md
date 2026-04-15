# Research: CLI TUI Reconstruction And Dual-Layer Operator Shell

## Document Metadata

- Status: `promoted`
- Owner: cli and gateway maintainers
- Last reviewed: `2026-04-14`
- Promotion target:
  - `docs/architecture/system-architecture.md`
  - `docs/reference/commands.md`
  - `docs/reference/configuration.md`
  - `docs/reference/session-lifecycle.md`
  - `docs/guide/cli.md`
  - `docs/journeys/operator/background-and-parallelism.md`

## Promotion Summary

This note is now a promoted status pointer.

The accepted decision is:

- Brewva interactive CLI is a dual-layer operator shell rather than a thin
  prompt loop
- one conversation shell remains the default home, with transcript, multiline
  composer, and bottom status bar
- approvals, questions, tasks, inspect, session switching, and pager drill-down
  are overlay or pager surfaces over the same Brewva session truth
- keyboard routing and completion stay context-scoped and Brewva-owned rather
  than being delegated to ad hoc widget-local state
- the shell does not introduce a hidden planner, a second command authority
  model, or a compatibility revival of the retired line-oriented interactive
  path

## Stable References

- `docs/architecture/system-architecture.md`
- `docs/reference/commands.md`
- `docs/reference/configuration.md`
- `docs/reference/session-lifecycle.md`
- `docs/guide/cli.md`
- `docs/journeys/operator/background-and-parallelism.md`

## Stable Contract Summary

1. One shell, multiple operator layers.
   The default experience is a single-session conversation shell. Operator
   surfaces are overlays or pagers, not separate terminal modes with their own
   truth.
2. Keyboard and completion are first-class shell contracts.
   Submit, multiline compose, steering, completion dismissal, list navigation,
   and approval/question shortcuts are documented and reducer-driven.
3. The status bar is a stable control-plane disclosure surface.
   It carries mode, model or thinking posture, follow state, approval/question
   badges, task hints, and contextual action suggestions.
4. Overlay lifecycle is explicit.
   Draft state survives overlay entry and exit, priority overlays queue
   cleanly, and drill-down pagers return to the originating shell surface.
5. Task and inspect review stay replay-visible.
   Task browser summaries and pager drill-down consume the same delegation and
   workflow state as the rest of Brewva; they do not maintain a TUI-private
   task registry.
6. Removed compatibility paths stay removed.
   Unsupported interactive terminals now degrade to print mode or fail fast
   rather than silently reviving the old prompt loop.

## Validation Status

Promotion is backed by:

- stable docs aligned across architecture, commands, configuration, session
  lifecycle, CLI guide, and operator delegation journey
- reducer, controller, and OpenTUI shell coverage for overlays, completion,
  focus restoration, session switching, and task-output drill-down
- repository verification via `bun run check`, `bun run test`,
  `bun run test:docs`, `bun run format:docs:check`, and `bun run test:dist`

## Source Anchors

- `packages/brewva-cli/src/shell/state/index.ts`
- `packages/brewva-cli/src/shell/controller.ts`
- `packages/brewva-cli/src/shell/transcript.ts`
- `packages/brewva-cli/src/shell/task-details.ts`
- `packages/brewva-cli/runtime/opentui-shell-renderer.tsx`
- `test/unit/cli/shell-state.unit.test.ts`
- `test/unit/cli/shell-controller.unit.test.ts`
- `test/unit/cli/opentui-shell-renderer.unit.test.ts`
- `test/unit/tui/focus-overlay.unit.test.ts`
- `test/unit/tui/keybinding-resolver.unit.test.ts`

## Remaining Backlog

The following are intentionally outside the promoted contract:

- a raw local shell mode parallel to the Brewva conversation shell
- hidden planner state or automatic operator actions without explicit input
- reviving the retired line-oriented interactive renderer as a compatibility
  fallback

If future work reopens any of those directions, it should start from a new
focused RFC rather than expanding this promoted pointer back into a proposal.

## Historical Notes

- Long-form option analysis, migration phases, and rollout detail were removed
  from this file after promotion.
- The stable shell contract now lives in the reference, guide, and journey
  docs plus the regression suite rather than in `docs/research/`.
