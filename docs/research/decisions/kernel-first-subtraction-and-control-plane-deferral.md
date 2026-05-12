# Decision: Kernel-First Subtraction And Control-Plane Deferral

## Metadata

- Decision: Keep the kernel boundary hard. `authority / inspect / maintain`, effect governance, exact resume, rollback receipts, and replay-first recovery remain the core contract.
- Date: `2026-04-18`
- Status: accepted
- Stable docs:
  - `docs/architecture/design-axioms.md`
  - `docs/architecture/system-architecture.md`
  - `docs/reference/runtime.md`
  - `docs/reference/extensions.md`
  - `docs/reference/tools.md`
  - `docs/guide/orchestration.md`
  - `docs/guide/gateway-control-plane-daemon.md`
  - `docs/reference/gateway-control-plane-protocol.md`
- Code anchors:
  - `N/A`

## Decision Summary

- Keep the kernel boundary hard. `authority / inspect / maintain`, effect governance, exact resume, rollback receipts, and replay-first recovery remain the core contract.
- Treat `single tool call` as the stable transaction boundary. Turn-level bounded recovery may evolve later, but cross-agent saga semantics and generalized compensation are explicitly deferred.
- Keep control-plane growth opt-in. New orchestration breadth must not widen the default hosted or runtime-plugin path without an explicit exception and compatibility story.
- Preserve advisory/control-plane replaceability. Routing, delegation, heartbeat behavior, and operator UX remain subordinate to kernel truth instead of becoming hidden authority.
- Promote accepted decisions into stable docs and keep the research pointer short. The stable contract now lives in architecture, reference, and guide docs, not in `docs/research/active/`.

## Superseded by

- None.
