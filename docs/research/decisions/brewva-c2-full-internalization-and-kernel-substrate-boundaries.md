# Decision: Brewva C2 Full Internalization and Kernel/Substrate Boundaries

## Metadata

- Decision: `C2` is the stable architectural direction: Brewva owns the full execution substrate rather than layering around `Pi runtime`
- Date: `2026-04-13`
- Status: accepted
- Stable docs:
  - `docs/architecture/design-axioms.md`
  - `docs/architecture/system-architecture.md`
  - `docs/reference/runtime.md`
  - `docs/reference/extensions.md`
  - `docs/reference/session-lifecycle.md`
- Code anchors:
  - `packages/brewva-substrate/src/**`
  - `packages/brewva-gateway/src/hosted/internal/session/**`
  - `packages/brewva-cli/src/cli-runtime.ts`

## Decision Summary

- `C2` is the stable architectural direction: Brewva owns the full execution substrate rather than layering around `Pi runtime`
- the cut line is `kernel` vs `substrate`, not `kernel` expansion; runtime authority remains narrow while session lifecycle, turn orchestration, prompt/context resource loading, and host-facing tool execution move into the substrate
- hosted, CLI, and channel execution routes converge on the same repo-owned substrate
- `Pi` compatibility is retained only for import/export and reference-study value, not for execution-path dependency
- The accepted decision is:

## Superseded by

- None.
