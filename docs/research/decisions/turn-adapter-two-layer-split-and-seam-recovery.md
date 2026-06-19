# Decision: Turn-Adapter Two-Layer Split And Substrate Seam Recovery

## Metadata

- Decision: The gateway `turn-adapter/` directory splits into its two real
  physical layers — `hosted/edge/` (worker-process turn boundary) and
  `hosted/internal/turn/` (the sequentially-coupled hosted adaptation chain over
  `runtime.turn`) — with hook lifecycle moved to `hosted/internal/hooks/`; the
  substrate `execution/` and `provenance/` internal barrels are dissolved; and the
  managed-session turn-facing runtime-provider callbacks are lifted into one
  `RuntimeProviderFace`.
- Date: `2026-06-20`
- Status: accepted
- Stable docs:
  - `docs/architecture/system-architecture.md`
  - `skills/project/shared/package-boundaries.md`
  - `docs/reference/artifacts-and-paths.md`
- Code anchors:
  - `packages/brewva-gateway/src/hosted/edge/worker/main.ts`
  - `packages/brewva-gateway/src/hosted/internal/turn/turn-envelope.ts`
  - `packages/brewva-gateway/src/hosted/internal/hooks/local-hook-port.ts`
  - `packages/brewva-gateway/src/hosted/internal/session/watchdog/task-progress-watchdog.ts`
  - `packages/brewva-gateway/src/hosted/internal/session/managed-agent/runtime-provider-face.ts`
  - `packages/brewva-substrate/src/tools/tool-phase.ts`
  - `packages/brewva-substrate/src/contracts/source-info.ts`
  - `test/fitness/turn-two-layer-boundary.fitness.test.ts`

## Decision Summary

- The "three duplicated turn layers" diagnosis was refuted. There is one
  execution skeleton (`runtime.turn`); the gateway `turn-adapter/` co-named a
  worker-process boundary and a sequentially-coupled hosted adaptation chain. The
  fix is naming, not merging — merging would pull timer/process IO into the
  interruptible kernel and undo the effect-approval/rollback closure.
- Two layers, not three. The hosted turn chain (entry → envelope → adapter →
  hosted ports → `runtime.turn`) is one authority layer; slicing it into
  wire/control/ports would mirror the implementation and manufacture
  cross-directory cycles along a sequentially-coupled chain. `hosted/edge/`
  (worker message protocol + process heartbeat) is the one genuinely orthogonal
  axis. Task-stall detection and adjudication remain session orchestration policy
  under `hosted/internal/session/watchdog/`; the edge worker only starts and stops
  that session-owned lifecycle. The public `@brewva/brewva-gateway/hosted` path
  remains frozen.
- Fitness invariants lock the boundary: `runtime/turn` imports no
  gateway; the worker message protocol is confined to edge (asserted
  non-vacuously on both sides); the turn chain calls no `kernel.beginToolCall`;
  the turn chain does not import edge; task-stall policy cannot move into edge;
  and turn dispatch accepts provider behavior only through a checked
  `RuntimeProviderFace`.
- Substrate seam recovery completes the ops-facade WS5 cut: the `execution/` and
  `provenance/` internal barrels (whose public subpaths were already removed)
  dissolve — `tool-phase` vocabulary folds into `tools/`, `source-info` into
  `contracts/`, and the zero-consumer event-bus is deleted. This supersedes their
  ownership in `substrate-sdk-diagnostics-and-compaction-mechanism-ports.md`.
- The session god-object is left deliberately intact except for one genuine
  separation point. Its bulk is necessary wiring (constructor closures capture
  `this`) plus a cohesive event machine. Turn-facing provider behavior is owned
  by `ManagedSessionRuntimeProviderFace`, which implements the required
  `RuntimeProviderFace` contract. The session exposes that face as one explicit
  capability; turn construction validates it once and no longer probes optional
  session methods, so verification gates and provider observations cannot vanish
  through duck-typing.

## Axioms

Obeys `docs/architecture/design-axioms.md`:

- Axiom 3 (`Subtraction beats switches`): dead barrels and the zero-consumer
  event-bus are deleted, not toggled; the misfiled hook lifecycle is relocated
  rather than aliased.
- Axiom 18 (`Descriptive metadata derives views, never authority`): the split is
  a structural rename plus internal-barrel recovery — it derives clearer
  directory views and widens no kernel authority.

No axiom is overridden. Fitness enforces directory ownership and the provider
capability contract, preventing silent boundary re-merging or a recreated
session duck-typing seam.
