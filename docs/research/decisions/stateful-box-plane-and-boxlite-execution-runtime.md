# Decision: Stateful Box Plane And BoxLite Execution Runtime

## Metadata

- Decision: Boxes are first-class execution workbenches. A scoped box preserves useful filesystem and process state across an agent's work instead of recreating a sandbox for every command.
- Date: `2026-04-26`
- Status: accepted
- Stable docs:
  - `docs/architecture/invariants-and-reliability.md`
  - `docs/architecture/system-architecture.md`
  - `docs/reference/configuration.md`
  - `docs/reference/events/README.md`
  - `docs/reference/exec-threat-model.md`
  - `docs/reference/runtime.md`
  - `docs/reference/tools.md`
  - `docs/solutions/security/exec-command-policy-and-readonly-shell.md`
- Code anchors:
  - `packages/brewva-tools/src/internal/box/index.ts`
  - `packages/brewva-tools/src/internal/box/boxlite/plane.ts`
  - `packages/brewva-tools/src/families/execution/box-plane-runtime.ts`
  - `packages/brewva-tools/src/families/execution/exec.ts`
  - `packages/brewva-runtime/src/config/defaults.ts`
  - `packages/brewva-runtime/src/config/field-policy.ts`
  - `packages/brewva-runtime/src/config/normalize-security.ts`
  - `script/build-binaries.ts`

## Decision Summary

- Boxes are first-class execution workbenches. A scoped box preserves useful filesystem and process state across an agent's work instead of recreating a sandbox for every command.
- Box state is explicit but non-authoritative. Brewva may inspect, reconcile, snapshot, and release boxes, but durable truth stays in the event tape, receipts, Recovery WAL, and replayable runtime records.
- Execution routing is fail-closed. If the selected box route cannot run, Brewva reports the isolated execution failure. It does not silently fall back to host execution.
- Configuration names match the current primitive. The public surface says `box`; retired `sandbox` and remote-service fields are rejected instead of kept as compatibility aliases.
- BoxLite is quarantined behind the tools-internal box plane. Runtime and distribution code consume Brewva's tool execution contracts, not raw BoxLite SDK shapes.

## Superseded by

- `docs/research/decisions/rfc-package-boundary-architecture-vnext.md` folds the
  former box package into tools while preserving the BoxPlane quarantine.
