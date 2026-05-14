# Decision: CLI/TUI Experience-Ring Decomposition And Shell Port Boundaries

## Metadata

- Decision: CLI and TUI are the operator Experience Ring. Runtime authority stays outside the shell, shell-facing runtime access is compressed to session/operator/config ports, and renderer code consumes shell view contracts instead of broad runtime objects.
- Date: `2026-05-14`
- Status: accepted
- Stable docs:
  - `docs/architecture/system-architecture.md`
  - `docs/architecture/control-and-data-flow.md`
  - `docs/guide/cli.md`
  - `docs/reference/commands.md`
  - `docs/reference/commands/interactive.md`
  - `docs/reference/session-lifecycle.md`
- Code anchors:
  - `packages/brewva-cli/src/index.ts`
  - `packages/brewva-cli/src/entry`
  - `packages/brewva-cli/src/commands`
  - `packages/brewva-cli/src/io`
  - `packages/brewva-cli/src/operator`
  - `packages/brewva-cli/src/session`
  - `packages/brewva-cli/src/shell/domain`
  - `packages/brewva-cli/src/shell/controller`
  - `packages/brewva-cli/src/shell/ports`
  - `packages/brewva-cli/runtime/opentui/index.ts`
  - `packages/brewva-cli/runtime/shell/overlays`
  - `packages/brewva-cli/runtime/internal-shell-runtime.ts`
  - `packages/brewva-cli/runtime/internal-opentui-runtime.ts`
  - `test/unit/cli/cli-shell-import-graph.unit.test.ts`
  - `test/fitness/cli/opentui-import-quarantine.fitness.test.ts`
  - `test/contract/cli/cli-package-export-surface.contract.test.ts`

## Decision Summary

- `packages/brewva-cli/src/index.ts` is a narrow entry composition surface. Argument parsing, help, runtime guard, mode resolution, command handlers, operator helpers, IO helpers, and session bootstrap live under explicit owners.
- The interactive shell domain owns typed inputs, actions, effects, state, selectors, view models, completion, prompt state, transcript projection contracts, and overlay payload contracts.
- Shell effects are explicit values. Effect execution does not directly write reducer state from success results; runtime results return through event ingestion, projection refresh, or shell input.
- Shell runtime-facing ports are compressed to session, operator, and config contracts. Terminal capability, paste, resize, and selection signals enter as shell input or renderer-local capability, not as a shell-owned terminal port.
- OpenTUI and native clipboard behavior are renderer/runtime capabilities. CLI shell source does not own direct OpenTUI imports or OS clipboard implementation details.
- Overlay payloads are keyed by exact overlay kind, and renderer overlay components are split by surface instead of sharing one broad payload dispatcher.
- The CLI package export surface is explicit. Removed root re-exports and legacy shell subpaths are intentionally not preserved for internal compatibility.

## Supersedes

- CLI/TUI implementation-planning portions of `docs/research/decisions/cli-tui-dual-layer-operator-shell.md`.
- Renderer contract portions of `docs/research/decisions/inspectable-operator-experience-overlays.md`.

## Superseded by

- None.
