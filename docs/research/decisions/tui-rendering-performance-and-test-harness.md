# Decision: TUI Rendering Performance And Test Harness

## Metadata

- Decision: the interactive shell hot path is optimized behind a deterministic replay benchmark and count-based fitness invariants, using a clock seam, flush-window coalescing, async completion refresh, structural-sharing view-model projection, and throttled streaming markdown, without replacing OpenTUI.
- Date: `2026-06-18`
- Status: accepted
- Stable docs:
  - `docs/architecture/system-architecture.md`
  - `test/README.md`
- Code anchors:
  - `packages/brewva-cli/src/shell/domain/clock.ts`
  - `packages/brewva-cli/src/shell/domain/view-model.ts`
  - `packages/brewva-cli/src/shell/projectors/session-event-coalescing.ts`
  - `packages/brewva-cli/runtime/shell/streaming-text.ts`
  - `test/bench/tui-streaming.bench.ts`

## Decision Summary

- A `ShellClock` seam in the CLI shell runtime makes timer-driven streaming deterministically testable.
- A session-replay performance harness plus count-based fitness invariants gate hot-path changes with measured work counts instead of static analysis.
- Streaming render pressure drops through flush-window event coalescing, structural-sharing view-model projection, throttled streaming markdown, and async default-off completion refresh.
- The roughly 100-row transcript window, OpenTUI, and the Solid reconciler are unchanged, and there is no public ACP or MCP wire change.

## Axioms

This decision is judged against `docs/architecture/design-axioms.md`:

- Obeys axiom 3 (Subtraction beats switches): per-frame full view-model cloning, O(n) per-token projector work, the scroll-sync feedback loop, and synchronous keystroke filesystem I/O are removed from the hot path rather than gated behind a flag.
- Obeys axiom 11 (Same evidence is not shared authority): the optimizations stay in the Experience ring; view-model projection and streaming change only how evidence is shown, granting no tool, approval, or kernel authority.

## Superseded by

- None.
