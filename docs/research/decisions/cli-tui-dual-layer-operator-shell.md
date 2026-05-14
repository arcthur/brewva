# Decision: CLI TUI Reconstruction And Dual-Layer Operator Shell

## Metadata

- Decision: One shell, multiple operator layers. The default experience is a single-session conversation shell. Operator surfaces are overlays or pagers, not separate terminal modes with their own truth.
- Date: `2026-04-14`
- Status: accepted
- Stable docs:
  - `docs/architecture/system-architecture.md`
  - `docs/reference/commands.md`
  - `docs/reference/configuration.md`
  - `docs/reference/session-lifecycle.md`
  - `docs/guide/cli.md`
  - `docs/journeys/operator/background-and-parallelism.md`
- Code anchors:
  - `packages/brewva-cli/src/shell/domain/state.ts`
  - `packages/brewva-cli/src/shell/controller/shell-runtime.ts`
  - `packages/brewva-cli/src/shell/domain/transcript.ts`
  - `packages/brewva-cli/src/shell/domain/task-details.ts`
  - `packages/brewva-cli/runtime/opentui-shell-renderer.tsx`
  - `test/unit/cli/shell-state.unit.test.ts`
  - `test/unit/cli/shell-runtime-*.unit.test.ts`
  - `test/unit/cli/opentui-shell-renderer-*.unit.test.ts`

## Decision Summary

- One shell, multiple operator layers. The default experience is a single-session conversation shell. Operator surfaces are overlays or pagers, not separate terminal modes with their own truth.
- Keyboard and completion are first-class shell contracts. Submit, multiline compose, queued-prompt controls, in-flight steer, completion dismissal, list navigation, and approval/question shortcuts are documented and reducer-driven.
- The status bar is a stable control-plane disclosure surface. It carries mode, model or thinking posture, follow state, approval/question badges, task hints, and contextual action suggestions.
- Overlay lifecycle is explicit. Draft state survives overlay entry and exit, priority overlays queue cleanly, and drill-down pagers return to the originating shell surface.
- Task and inspect review stay replay-visible. Task browser summaries and pager drill-down consume the same delegation and workflow state as the rest of Brewva; they do not operator a TUI-private task registry.

## Superseded by

- `docs/research/decisions/cli-tui-experience-ring-decomposition-and-shell-port-boundaries.md` supersedes the implementation-planning portions of this decision.
