# Decision: Effect Infrastructure Island Boundary

## Metadata

- Decision: Effect is an infrastructure island for scoped mechanics, not a semantic runtime control plane.
- Date: `2026-05-20`
- Status: accepted
- Stable docs:
  - `docs/architecture/system-architecture.md`
  - `docs/architecture/exploration-and-effect-governance.md`
  - `docs/architecture/invariants-and-reliability.md`
  - `docs/reference/runtime.md`
  - `docs/reference/provider-streaming.md`
  - `docs/reference/tools.md`
  - `skills/project/shared/package-boundaries.md`
  - `skills/project/shared/anti-patterns.md`
- Code anchors:
  - `packages/brewva-std/src/async.ts`
  - `packages/brewva-runtime/src/runtime/engine/turn.ts`
  - `packages/brewva-effect/src/schedules.ts`
  - `packages/brewva-gateway/src/channels/effect-serial-queue.ts`
  - `packages/brewva-gateway/src/hosted/internal/turn-adapter/runtime-turn-execution-ports.ts`
  - `packages/brewva-provider-core/src/stream/run-provider-stream.ts`
  - `packages/brewva-provider-core/src/stream/index.ts`
  - `packages/brewva-tools/src/families/execution/exec-process-registry/service.ts`
  - `packages/brewva-tools/src/families/execution/exec-process-registry/runtime.ts`
  - `test/fitness/effect-runtime-boundary.fitness.test.ts`

## Decision Summary

- `@brewva/brewva-runtime` remains ordinary TypeScript. Its public root stays
  `identity`, `config`, `tape`, `kernel`, `model`, `start`, `turn`, and
  `close`; it must not expose Effect values, Effect services, or semantic
  Effect layers.
- `@brewva/brewva-effect` owns raw Effect dependencies, boundary runners,
  scoped resource helpers, schedules, retry policy, config-service helpers,
  testing helpers, and structural observability. Effect primitive aliases remain
  explicit through `@brewva/brewva-effect/primitives`.
- Provider streams, gateway channel mechanics, tool execution process
  management, substrate plugin guards, daemon lifecycle, ingress, and worker
  operations may use Effect for scopes, finalizers, fibers, streams, queues,
  schedules, typed infrastructure failures, retry, and tracing.
- Effect islands keep their core workflows Effect-native and expose thin
  Promise-friendly adapters only at declared package or process boundaries.
  Internal offer/await/close mechanics must not repeatedly call
  `runBoundaryOperation`.
- Runtime turn handoff remains plain TypeScript and uses
  `createAsyncBridge(...)` for bounded backpressure, abort, failure, close, and
  early-consumer-exit cleanup without importing Effect into runtime.
- Provider-core stream producers write through Effect-returning sinks and
  compose SDK calls with `BrewvaEffect.tryPromise`; stream completion is the
  adapter boundary that maps the Effect stream back to Promise results.
- Gateway channel serial execution is a scoped Effect service with one runtime
  adapter. Queue construction, enqueue, idle waiting, failure, and close live
  inside the service until the adapter edge.
- Managed exec process state is owned by an explicit
  `ManagedExecProcessRegistryRuntime`. Host, box, process-session, cleanup, and
  background-session APIs use that runtime instead of module-level singleton
  maps.
- `runBoundaryOperation` is allowed only in the Effect foundation, testing, and
  declared adapter files enforced by fitness tests. Provider stream core,
  channel queue core, tool execution internals, and runtime package code are not
  boundary runners.

## Supersedes

- Effect-runtime-layer guidance in
  `docs/research/decisions/effect-native-runtime-foundation.md`
- Runtime-controller Effect consumer guidance in
  `docs/research/decisions/runtime-factory-ports.md`
- Runtime-controller Effect consumer guidance in
  `docs/research/decisions/rfc-narrow-and-provable-runtime-boundaries.md`

## Verification

- `bun run check`
- `bun test --timeout 600000`
- `bun run test:docs`
- `bun run test:dist`
