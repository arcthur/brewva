# Decision: CLI Shell Import Graph Baseline

## Metadata

- Decision: CLI shell import direction, cycle freedom, renderer boundaries, and OpenTUI quarantine are accepted architecture gates, not temporary review heuristics.
- Date: `2026-05-14`
- Status: accepted
- Stable docs:
  - `docs/architecture/control-and-data-flow.md`
  - `docs/guide/cli.md`
- Code anchors:
  - `test/unit/cli/cli-shell-import-graph.unit.test.ts`
  - `test/contract/cli/opentui-import-quarantine.contract.test.ts`
  - `test/contract/cli/cli-package-export-surface.contract.test.ts`
  - `packages/brewva-cli/src/shell/domain`
  - `packages/brewva-cli/runtime/opentui/index.ts`

## Decision Summary

- CLI shell domain imports stay inside `packages/brewva-cli/src/shell/domain/**`; domain modules do not reach back into controller, ports, overlays, renderer, runtime, or OpenTUI implementation paths.
- Runtime shell renderer code consumes shell domain contracts and local OpenTUI adapter exports. It does not import broad controller, state, or runtime internals.
- The runtime-value shell graph is cycle-free, and shell command, completion, action, and state contracts stay acyclic.
- Direct CLI `@opentui/*` imports stay behind `packages/brewva-cli/runtime/opentui/index.ts`; TUI direct OpenTUI imports stay behind the Bun-only internal runtime seam.
- Legacy broad shell files, including `shell/types.ts`, `shell/runtime.ts`, `shell/state/index.ts`, `shell/overlay-view.ts`, `runtime/shell/overlay.tsx`, and `shell/clipboard.ts`, remain deleted.

## Superseded by

- None.
