# Decision: TUI Split-Footer Native Scrollback Renderer

## Metadata

- Decision: the interactive shell is an OpenTUI split-footer renderer that commits settled transcript to the terminal's immutable native scrollback and keeps only a bounded live footer, replacing the alt-screen `scrollbox` transcript.
- Date: `2026-06-21`
- Status: accepted
- Stable docs:
  - `docs/architecture/system-architecture.md`
  - `docs/reference/commands/interactive.md`
  - `docs/guide/cli.md`
  - `docs/reference/working-projection.md`
- Code anchors:
  - `packages/brewva-cli/runtime/opentui-shell-renderer.tsx`
  - `packages/brewva-cli/runtime/shell/app.tsx`
  - `packages/brewva-cli/runtime/shell/split-footer-scrollback-writer.tsx`
  - `packages/brewva-cli/runtime/shell/streaming-scrollback-entry.ts`
  - `packages/brewva-cli/src/shell/domain/scrollback/commit.ts`
  - `packages/brewva-cli/src/shell/domain/cockpit/wire-fold.ts`

## Decision Summary

- The renderer splits the terminal: settled transcript is written once to native
  scrollback, and a bounded live footer holds the composer, status line, and
  inline notifications, modals, completion, cockpit, and subagent surfaces.
- The wire-fold projector emits an append-only, typed `ScrollbackCommit` log
  keyed by a stable logical id, so a turn's streamed answer and its committed
  re-segmentation collapse to one entry. `SplitFooterScrollbackWriter` drains
  that log through a commit cursor (two-phase ack, no per-frame history rescan):
  it streams the in-flight answer's stable markdown blocks through a
  `StreamingScrollbackEntry` and commits settled messages once through the real
  `TranscriptMessageView`, so a turn's answer reaches scrollback exactly once.
- Transcript kinds the commit log never carries (seed, user, hydrated wire
  history) are rendered by a high-water-marked settled sweep, deduplicated
  against the cursor drain through a shared committed-id set.
- The transcript is never repainted per frame: committed scrollback is immutable
  terminal history, which eliminates the streaming-markdown flicker the
  alt-screen software-scroll repaint produced without DEC-2026 synchronized output.
- The alt-screen live `scrollbox` transcript, its row-retention window, and its
  throttled streaming-markdown preview are deleted, not retained behind a flag.
- A session switch, full re-hydrate, or in-place rewind/redo/undo replaces prior
  history rather than appending: `clearNativeScrollbackForReplay` calls 0.4.1
  `resetSplitFooterForReplay({ clearSavedLines: true })` to wipe the split-footer +
  saved lines before re-anchoring (earlier notes wrongly deferred this as absent).
  A session switch replays the fresh log; rewind/redo/undo skip abandoned commits
  and re-sweep the shorter transcript via a `rewindGeneration` signal vs the epoch.

## Limitations

- `ScrollbackSurface` exposes only a `readonly width` in 0.4.1 (no setWidth/
  resize/reflow API), so a mid-stream resize leaves the in-flight turn's live
  block at its creation width until the `final` re-renders at the current width;
  `renderer.resize()` resizes only the live renderer, not committed rows.
- Committed rows are immutable terminal history: a palette change recolors only
  the trailing live block, and a transcript-preserving editor suspend can
  bound-repeat a shown prefix. The whole-history clear covers switches + rewinds.

## Axioms

This decision is judged against `docs/architecture/design-axioms.md`:

- Obeys axiom 3 (Subtraction beats switches): the alt-screen `scrollbox`
  transcript path, the ~100-row retention window, and the streaming-markdown
  throttle are removed from the default product path rather than gated behind a
  compatibility toggle.
- Obeys axiom 11 (Same evidence is not shared authority): the renderer stays in
  the Experience ring; committing transcript to native scrollback changes only
  how evidence is shown and grants no tool, approval, or kernel authority.

## Supersedes

- `tui-bounded-live-cockpit-and-native-scrollback.md` (its bounded-`scrollbox`
  cockpit premise is replaced by native-scrollback commit).
- The transcript-window and throttled-streaming-markdown portions of
  `tui-rendering-performance-and-test-harness.md`.

## Superseded by

- None.
