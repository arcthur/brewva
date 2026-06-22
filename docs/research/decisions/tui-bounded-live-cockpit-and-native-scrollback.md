# Decision: TUI Bounded Live Cockpit And Native Scrollback

## Metadata

- Decision: The interactive shell is a bounded live cockpit backed by OpenTUI
  native scrollback, not a full-history transcript virtualizer.
- Date: `2026-05-31`
- Status: accepted
- Stable docs:
  - `docs/reference/commands/interactive.md`
  - `docs/guide/cli.md`
  - `docs/reference/working-projection.md`
- Code anchors:
  - `packages/brewva-cli/runtime/shell/app.tsx`
  - `packages/brewva-cli/runtime/shell/cockpit/surface.tsx`
  - `packages/brewva-cli/src/shell/domain/cockpit/`
  - `packages/brewva-cli/src/shell/projectors/transcript-projector.ts`
  - `test/unit/cli/opentui-shell-renderer-interaction-events.unit.test.ts`

## Decision Summary

- The main interactive TUI renders a bounded live working set: recent
  transcript rows plus all currently streaming rows.
- Older transcript evidence stays available through explicit archive,
  transcript, export, and pager surfaces.
- The default renderer path uses OpenTUI native `scrollbox`, sticky bottom
  follow, and renderer-local scroll synchronization. It does not run a custom
  measured row virtualizer in the production main shell.
- Full-history transcript virtualization is reserved for a future explicit
  history surface if profiling proves it is needed.
- Live session projection remains single-source. Session wire fold produces the
  semantic live snapshot; cockpit and transcript views consume that folded
  snapshot instead of running parallel legacy projection during streaming.
- Legacy session-event projection remains available only for explicit adapters
  without wire-fold hydration. One active viewport uses exactly one projection
  source at a time.
- Long tool output and receipt detail stay summarized in the cockpit and open
  through archive or pager refs. The main cockpit does not expand raw tool
  output into the base spatial model.

## Rationale

Brewva's cockpit exists for current work, decisions, effects, attention, and
recovery. A full transcript is audit evidence, not the default live work
surface. The smooth terminal path keeps the mounted tree small, avoids per-row
measurement loops during streaming, and lets OpenTUI own ordinary scrolling.

## Runtime Shape

The shell renderer builds rows from the folded session snapshot, splits stable
rows from live rows, keeps only the stable tail that fits the internal row
budget, always retains live rows, and renders the result directly in OpenTUI
`scrollbox`. The row budget is renderer-local policy, not a public API.

## Deleted Path

The default interactive shell removes JS virtualizer state, row measurement
callbacks, spacer synthesis, estimated-height scroll compensation, and tests
that assert full-history top navigation inside the base cockpit.

## Non-goals

- No full transcript browsing guarantee inside the base cockpit shell.
- No public runtime API for renderer row budgets.
- No compatibility mode that keeps custom virtualized and native scrollback
  paths active at the same time.
- No second projection line for streaming preview events.

## Supersedes

- The full-history transcript virtualization portions of the in-progress TUI
  smoothness work.

## Superseded by

- `tui-split-footer-native-scrollback-renderer.md`. The bounded-`scrollbox`
  cockpit premise is replaced: settled transcript is now committed to the
  terminal's immutable native scrollback rather than rendered inside an
  alt-screen `scrollbox`, and the renderer-local row-retention window is removed.
