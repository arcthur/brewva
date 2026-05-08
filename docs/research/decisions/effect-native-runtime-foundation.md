# Decision: Effect-Native Runtime Foundation

## Metadata

- Decision: Effect is Brewva's internal runtime mechanics substrate for long-running effectful execution
- Date: `2026-05-07`
- Status: accepted
- Stable docs:
  - `docs/architecture/system-architecture.md`
  - `docs/architecture/exploration-and-effect-governance.md`
  - `docs/architecture/invariants-and-reliability.md`
  - `docs/reference/runtime.md`
  - `docs/reference/tools.md`
  - `docs/reference/configuration.md`
  - `docs/reference/events/README.md`
  - `docs/reference/provider-streaming.md`
  - `docs/reference/runtime-plugins.md`
- Code anchors:
  - `packages/brewva-effect/src/index.ts`
  - `packages/brewva-effect/src/edge.ts`
  - `packages/brewva-effect/src/boundary.ts`
  - `packages/brewva-effect/src/platform-node.ts`
  - `packages/brewva-effect/src/runtime-spine.ts`
  - `packages/brewva-effect/src/schedules.ts`
  - `packages/brewva-effect/src/scopes.ts`
  - `packages/brewva-runtime/src/runtime/effect-runtime-layer.ts`
  - `packages/brewva-runtime/src/runtime-effect.ts`
  - `packages/brewva-substrate/src/turn/effect-runtime.ts`
  - `packages/brewva-substrate/src/turn/loop.ts`
  - `packages/brewva-provider-core/src/stream/run-provider-stream.ts`
  - `packages/brewva-tools/src/families/execution/exec-process-registry/api.ts`
  - `packages/brewva-gateway/src/channels/channel-host-lifecycle.ts`
  - `packages/brewva-gateway/src/channels/effect-serial-queue.ts`
  - `packages/brewva-ingress/src/telegram-webhook-worker.ts`
  - `packages/brewva-mcp-adapter/src/index.ts`

## Decision Summary

- Brewva adopts `effect@4.0.0-beta.60` as the internal programming model for runtime mechanics: services, layers, scopes, fibers, streams, schedules, typed runtime failures, boundary bridges, and structural observability.
- `@brewva/brewva-effect` is the only package that may own direct Effect platform and observability dependencies. Its root is a thin re-export spine over purpose-specific modules (`boundary`, `observability`, `scopes`, `schedules`, `runtime-spine`, `platform-node`, and `testing`), and selected modules are exposed as explicit package subpaths for long-term import hygiene. Other packages import Effect primitives through Brewva-owned aliases and helpers.
- Effect coordinates in-memory execution only. Durable authority, receipts, event tape, WAL recovery, ledger evidence, DuckDB rebuildability, rollback semantics, and capability-scoped runtime ports remain Brewva-owned.
- Provider streams are Effect streams with typed provider errors, scoped provider request ownership, interruptible SDK boundaries, and queue-backed backpressure. The Promise-first `AssistantMessageEventStream` compatibility class is removed.
- Turn execution, tool invocation, process execution, box execution, gateway supervision, worker IPC, channel lifecycle, ingress, MCP operations, and runtime-plugin callback guards run through Effect-native core paths with Promise-friendly adapters only at external boundaries.
- Public edges run one Effect program per logical command, request, message, fetch, plugin callback, or worker lifecycle operation. Platform-neutral Worker code uses `@brewva/brewva-effect/edge` so it does not pull Node platform adapters into edge bundles.
- Structural observability is owned by `@brewva/brewva-effect`: spans and log annotations are applied in common helpers, while the Node runtime path can opt into `@effect/opentelemetry` `NodeSdk` processors through the foundation layer.
- Runtime internals are composed through Effect layers behind the `BrewvaRuntime` facade. The internal runtime-effect subpath exposes implementation services and runners, not `runtime.authority`, `runtime.inspect`, or `runtime.maintain`.
- Capability-scoped ports remain the only path for tools and plugins to gain runtime access. Effect layer availability never grants authority.
- Provider-specific retry classification remains local to each protocol, but retry budgets, schedules, interruption, and service-directed delay handling use the shared Effect retry policy when a provider owns a retryable request loop.
- Pure domain logic remains plain TypeScript unless it needs effectful dependencies.

## Superseded by

- None.
