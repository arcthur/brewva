# Research: OpenTUI Adoption For Brewva CLI Shell And Native Boundary

## Document Metadata

- Status: `promoted`
- Owner: cli and distribution maintainers
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

- Brewva adopts OpenTUI as the default interactive shell substrate
- `@brewva/brewva-tui` remains the repo-owned quarantine boundary for terminal
  capability policy and Bun-only native runtime code
- `@brewva/brewva-cli` continues to own shell state, ports, operator semantics,
  and replay-visible truth
- OpenTUI owns rendering, editor, viewport, layout, cursor, and selection
  mechanics rather than Brewva-specific operator state
- the interactive shell runs in `alternate-screen`
- Brewva pins `@opentui/core` to `0.1.99` and vendors the React reconciler
  snapshot under `packages/brewva-tui/runtime/vendor/opentui-react`
- promoted interactive packaging scope now covers `darwin-arm64`, `darwin-x64`,
  `linux-x64` (glibc), `linux-arm64` (glibc), and `windows-x64`, while musl
  builds remain non-interactive

## Stable References

- `docs/architecture/system-architecture.md`
- `docs/reference/commands.md`
- `docs/reference/configuration.md`
- `docs/reference/session-lifecycle.md`
- `docs/guide/cli.md`
- `docs/journeys/operator/background-and-parallelism.md`

## Stable Contract Summary

1. Quarantine boundary stays explicit.
   The root `@brewva/brewva-tui` surface remains Node-safe for dist smoke and
   non-interactive imports, while the OpenTUI runtime stays behind the Bun-only
   internal seam.
2. Interactive-only loading is a hard invariant.
   CLI resolves mode and terminal capability first, then dynamically loads the
   OpenTUI runtime only for viable interactive execution.
3. Brewva truth and renderer truth remain separated.
   OpenTUI does not own approvals, questions, tasks, inspect state, sessions,
   or transcript semantics.
4. Packaging policy is release-visible.
   CI now builds and smoke-verifies the promoted interactive matrix, rather than
   only the initial Phase 0 proof targets.
5. Platform policy stays narrow and explicit.
   Musl builds continue shipping non-interactive Brewva binaries and fail fast
   for interactive OpenTUI mode until compatible native artifacts exist.
6. The retired custom interactive renderer is not preserved as a fallback.
   Unsupported interactive execution degrades to print mode or exits with a
   clear error instead of reviving the old path.

## Validation Status

Promotion is backed by:

- stable docs aligned across architecture, commands, configuration, session
  lifecycle, CLI guide, and operator delegation journey
- `bun run check`
- `bun run test`
- `bun run test:docs`
- `bun run format:docs:check`
- `bun run test:dist`
- local binary packaging proof via
  `BREWVA_BINARY_TARGETS=brewva-darwin-arm64 BREWVA_SHELL_SMOKE=1 bun run build:binaries`
  plus `./distribution/brewva-darwin-arm64/bin/brewva --help`
- CI packaging matrix coverage for `linux-x64`, `linux-arm64`, `darwin-arm64`,
  `darwin-x64`, and `windows-x64`

## Source Anchors

- `packages/brewva-tui/src/index.ts`
- `packages/brewva-tui/runtime/internal-opentui-runtime.ts`
- `packages/brewva-cli/src/index.ts`
- `packages/brewva-cli/src/interactive-mode.ts`
- `packages/brewva-cli/runtime/internal-shell-runtime.ts`
- `packages/brewva-cli/runtime/opentui-shell-renderer.tsx`
- `script/build-binaries.ts`
- `script/verify-dist.ts`
- `.github/workflows/ci.yml`
- `test/contract/tui/tui-entrypoint.contract.test.ts`
- `test/contract/tui/tui-internal-runtime.contract.test.ts`
- `test/unit/cli/interactive-mode.unit.test.ts`

## Remaining Backlog

The following are intentionally not part of the promoted contract:

- musl interactive support before native OpenTUI artifacts are available
- a main-screen or stdout-capture shell mode parallel to the alternate-screen
  shell
- scattering direct `@opentui/core` imports across unrelated Brewva packages

If future work reopens any of those directions, it should start from a new
focused RFC rather than widening this promoted pointer.

## Historical Notes

- Phase-by-phase adoption detail and option analysis were removed after
  promotion.
- The stable contract now lives in the architecture/reference/guide docs, the
  CLI/TUI implementation, and the packaging verification suite.
