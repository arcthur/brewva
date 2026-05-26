# Four-Port Runtime Simplification

- Decision: Promote the four-port runtime as Brewva's current runtime architecture.
- Date: 2026-05-19
- Status: accepted
- Stable docs:
  - `docs/architecture/design-axioms.md`
  - `docs/architecture/system-architecture.md`
  - `docs/architecture/control-and-data-flow.md`
  - `docs/reference/runtime.md`
  - `docs/reference/session-lifecycle.md`
  - `docs/reference/gateway-control-plane-protocol.md`
  - `docs/reference/tools.md`
  - `skills/project/shared/package-boundaries.md`
  - `skills/project/shared/anti-patterns.md`
- Code anchors:
  - `packages/brewva-runtime/src/runtime/runtime.ts`
  - `packages/brewva-runtime/src/runtime/runtime-api.ts`
  - `packages/brewva-runtime/src/runtime/tape/impl.ts`
  - `packages/brewva-runtime/src/runtime/kernel/impl.ts`
  - `packages/brewva-runtime/src/runtime/model/impl.ts`
  - `packages/brewva-runtime/src/runtime/turn/impl.ts`
  - `packages/brewva-gateway/src/hosted/internal/turn-adapter/runtime-turn-adapter.ts`
  - `test/fitness/runtime-promoted-architecture.fitness.test.ts`
  - `test/fitness/effect-runtime-boundary.fitness.test.ts`

## Decision Summary

- Brewva's public runtime root is `identity`, `config`, `tape`, `kernel`,
  `model`, `start`, `turn`, and `close`; removed root, hosted, tool, operator,
  authority, inspect, and compatibility runtime surfaces stay deleted.
- Runtime owns the turn loop and physical constraints; Gateway hosted code is a
  transport/session adapter over `runtime.turn` and must not own transition
  truth, recovery policy, or canonical tape writes.
- Runtime physics is explicit construction input through
  `BrewvaRuntimeOptions.physics`; default provider fallbacks and implicit
  `EMPTY_PROVIDER` turn paths stay deleted.
- Tape owns committed truth through the canonical event vocabulary and derived
  projections; no public append method, global symbol escape hatch, old JSONL
  registry, or compatibility event writer is allowed.
- Kernel owns consequence with a two-phase tool transaction: policy admission
  and approval happen before tool execution, and commit/abort receipts are the
  only way tool facts reach Tape.
- Kernel also owns the narrow advisory custom event path; it can record only
  `custom` events with `authority: "advisory"` and cannot carry commitment
  authority or replace canonical event kinds.
- Model owns attention through materialization and checkpoint candidates without
  owning provider physics or effect authorization.
- Effect remains an infrastructure island for resource scope, retry,
  cancellation, queue/stream, and concurrency boundaries; semantic domain
  Effect layers and public Effect runtime types are forbidden.
- Substrate no longer provides a public turn loop or SDK bypass; reusable
  substrate pieces are protocol, prompt, session, provider, tool, persistence,
  and execution primitives only.
- Product-domain contracts that remain exported are narrow semantic contracts,
  not a legacy runtime surface; fitness tests prevent loose typing budgets,
  compatibility subpaths, and old writer names from growing back.

## Superseded Decisions

- `docs/research/decisions/runtime-domain-slicing-and-controlled-extension-ports.md`
- `docs/research/decisions/runtime-boundary-subtraction-and-effect-clarity.md`
- `docs/research/decisions/runtime-public-root-compression.md`
- `docs/research/decisions/hosted-turn-transitions-and-bounded-recovery.md`
- `docs/research/decisions/substrate-turn-loop-internalization.md`
- Any runtime-shape decision record that now carries `Superseded by:
four-port-runtime-simplification-rfc.md`; those records remain as historical
  provenance only and are not implementation guidance.

## Follow-Up Decisions

- `docs/research/decisions/runtime-axis-decoupling-and-vocabulary-boundary.md`
  accepts the physics, observation, vocabulary, topology, and hosted ops capability contracts.

## Verification

- `bun run check`
- `bun test --timeout 600000`
- `bun run test:docs`
- `bun run test:dist`
