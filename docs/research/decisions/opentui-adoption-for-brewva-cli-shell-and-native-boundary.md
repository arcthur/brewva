# Decision: OpenTUI Adoption For Brewva CLI Shell And Native Boundary

## Metadata

- Decision: Quarantine boundary stays explicit inside `@brewva/brewva-cli`. Stable TUI helpers live under CLI internals, while the OpenTUI runtime stays behind the Bun-only internal seam.
- Date: `2026-04-19`
- Status: accepted
- Stable docs:
  - `docs/architecture/system-architecture.md`
  - `docs/reference/commands.md`
  - `docs/reference/configuration.md`
  - `docs/reference/session-lifecycle.md`
  - `docs/guide/cli.md`
  - `docs/journeys/operator/background-and-parallelism.md`
- Code anchors:
  - `packages/brewva-cli/src/internal/tui/index.ts`
  - `packages/brewva-cli/runtime/internal-opentui-runtime.ts`
  - `packages/brewva-cli/src/index.ts`
  - `packages/brewva-cli/src/interactive-mode.ts`
  - `packages/brewva-cli/runtime/internal-shell-runtime.ts`
  - `packages/brewva-cli/runtime/opentui-shell-renderer.tsx`
  - `script/build-binaries.ts`
  - `script/verify-dist.ts`

## Decision Summary

- Quarantine boundary stays explicit inside `@brewva/brewva-cli`. Stable TUI helpers live under `packages/brewva-cli/src/internal/tui`, while the OpenTUI runtime stays behind `packages/brewva-cli/runtime/internal-opentui-runtime.ts`.
- Interactive-only loading is a hard invariant. CLI resolves mode and terminal capability first, then dynamically loads the OpenTUI runtime only for viable interactive execution.
- Brewva truth and renderer truth remain separated. OpenTUI does not own approvals, questions, tasks, inspect state, sessions, or transcript semantics.
- Packaging policy is release-visible. CI now builds and smoke-verifies the promoted interactive matrix, rather than only the initial Phase 0 proof targets.
- Platform policy stays narrow and explicit. Musl builds continue shipping non-interactive Brewva binaries and fail fast for interactive OpenTUI mode until compatible native artifacts exist.

## Non-goals

- musl interactive support before native OpenTUI artifacts are available
- a main-screen or stdout-capture shell mode parallel to the alternate-screen shell
- scattering direct `@opentui/core` imports across unrelated Brewva packages or
  non-runtime CLI source

## Superseded by

- `docs/research/decisions/rfc-package-boundary-architecture-vnext.md` folds the
  former TUI package into CLI while preserving this quarantine invariant.
