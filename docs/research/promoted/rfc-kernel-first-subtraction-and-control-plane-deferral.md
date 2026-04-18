# Research: Kernel-First Subtraction And Control-Plane Deferral

## Document Metadata

- Status: `promoted`
- Owner: runtime, gateway, and tools maintainers
- Last reviewed: `2026-04-18`
- Promotion target:
  - `docs/architecture/design-axioms.md`
  - `docs/architecture/system-architecture.md`
  - `docs/reference/runtime.md`
  - `docs/reference/runtime-plugins.md`
  - `docs/reference/tools.md`
  - `docs/guide/orchestration.md`
  - `docs/guide/gateway-control-plane-daemon.md`
  - `docs/reference/gateway-control-plane-protocol.md`

## Promotion Summary

This note is now a short status pointer.

The promoted decision is:

- Brewva remains kernel-first: effect governance, approval, replay, rollback,
  and recovery stay the hard center of the framework
- the current stable authority-bearing transaction boundary is
  `single tool call`
- runtime and substrate narrow default-path complexity before platform breadth
  expands again
- multi-agent and broader control-plane growth remain opt-in until compensation,
  backpressure, and partial-failure semantics become concrete enough for a new
  focused RFC

## Stable Contract Summary

The promoted contract is:

1. Keep the kernel boundary hard.
   `authority / inspect / maintain`, effect governance, exact resume, rollback
   receipts, and replay-first recovery remain the core contract.
2. Treat `single tool call` as the stable transaction boundary.
   Turn-level bounded recovery may evolve later, but cross-agent saga
   semantics and generalized compensation are explicitly deferred.
3. Keep control-plane growth opt-in.
   New orchestration breadth must not widen the default hosted or
   runtime-plugin path without an explicit exception and compatibility story.
4. Preserve advisory/control-plane replaceability.
   Routing, delegation, heartbeat behavior, and operator UX remain subordinate
   to kernel truth instead of becoming hidden authority.
5. Promote accepted decisions into stable docs and keep the research pointer
   short.
   The stable contract now lives in architecture, reference, and guide docs,
   not in `docs/research/active/`.

## Stable References

- `docs/architecture/design-axioms.md`
- `docs/architecture/system-architecture.md`
- `docs/reference/runtime.md`
- `docs/reference/runtime-plugins.md`
- `docs/reference/tools.md`
- `docs/guide/orchestration.md`
- `docs/guide/gateway-control-plane-daemon.md`
- `docs/reference/gateway-control-plane-protocol.md`

## Validation Status

Promotion is backed by:

- Wave 1 through Wave 5 implementation work landing in runtime, gateway,
  tools, and deliberation
- stable docs now carrying the `single tool call` transaction boundary and the
  deferred scope for cross-agent compensation semantics
- gateway/orchestration docs explicitly stating their current non-goals around
  compensation and partial-failure repair
- repository verification through `bun run check`, `bun test`,
  `bun run test:docs`, and `bun run format:docs:check`

## Remaining Backlog

The following areas remain intentionally outside the promoted contract:

- any cross-agent saga or compensation protocol
- default-path backpressure guarantees across the broader orchestration plane
- widening the default hosted or runtime-plugin path with new orchestration
  assumptions

If those areas need expansion, they should start from a new focused RFC rather
than reopening this promoted pointer as a mixed roadmap and contract note.
