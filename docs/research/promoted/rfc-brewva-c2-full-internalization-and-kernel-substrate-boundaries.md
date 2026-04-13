# Research: Brewva C2 Full Internalization and Kernel/Substrate Boundaries

## Document Metadata

- Status: `promoted`
- Owner: runtime and gateway maintainers
- Last reviewed: `2026-04-13`
- Promotion target:
  - `docs/architecture/design-axioms.md`
  - `docs/architecture/system-architecture.md`
  - `docs/reference/runtime.md`
  - `docs/reference/runtime-plugins.md`
  - `docs/reference/session-lifecycle.md`

## Promotion Summary

This note is now a promoted status pointer.

The accepted decision is:

- `C2` is the stable architectural direction: Brewva owns the full execution
  substrate rather than layering around `Pi runtime`
- the cut line is `kernel` vs `substrate`, not `kernel` expansion; runtime
  authority remains narrow while session lifecycle, turn orchestration,
  prompt/context resource loading, and host-facing tool execution move into the
  substrate
- hosted, CLI, and channel execution routes converge on the same repo-owned
  substrate
- `Pi` compatibility is retained only for import/export and reference-study
  value, not for execution-path dependency

## Stable References

- `docs/architecture/design-axioms.md`
- `docs/architecture/system-architecture.md`
- `docs/reference/runtime.md`
- `docs/reference/runtime-plugins.md`
- `docs/reference/session-lifecycle.md`

## Current Implementation Notes

- `packages/brewva-substrate/src/**` now carries the shared substrate-owned
  session, provider, host plugin, and tool contracts.
- `packages/brewva-gateway/src/host/**` and
  `packages/brewva-cli/src/cli-runtime.ts` route hosted and CLI execution
  through that same substrate-owned session bootstrap.
- approval steady states preserve explicit `tool_inflight` identity, so
  approval, recovery, and operator inspection no longer lose the active tool
  context.
- `AGENTS.md` and workspace manifests now reflect the package split across
  `substrate`, `agent-engine`, `provider-core`, and `recall`.

## Non-Goals Preserved From The RFC

- this promotion does not claim that every repo-owned package must stop using
  `@brewva/brewva-runtime/internal`; the accepted boundary is narrower:
  `substrate` must not depend on runtime internals to define the shared
  execution foundation
- this promotion does not canonize any `Pi` UX parity requirement for
  interactive CLI; the stable decision is shared runtime truth with
  Brewva-owned product UX freedom

## Remaining Backlog

- if future work materially changes the `kernel` / `substrate` / control-plane
  split, start a new focused RFC instead of reopening this promoted pointer
- if import/export compatibility with legacy `Pi` artifacts changes
  substantially, capture that as a separate migration or archive note
