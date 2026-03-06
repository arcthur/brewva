# Reference: Extensions

Extension factory entrypoint: `packages/brewva-extensions/src/index.ts`.

## Factory API

- `createBrewvaExtension`
- `brewvaExtension`

Factory options:

- `registerTools?: boolean` (default `true`)

## Registered Handlers

Default extension composition wires:

- `registerEventStream`
- `registerContextTransform`
- `registerScanConvergenceGuard`
- `registerQualityGate`
- `registerLedgerWriter`
- `registerCompletionGuard`
- `registerNotification`

Implementation files:

- `packages/brewva-extensions/src/event-stream.ts`
- `packages/brewva-extensions/src/context-transform.ts`
- `packages/brewva-extensions/src/scan-convergence-guard.ts`
- `packages/brewva-extensions/src/quality-gate.ts`
- `packages/brewva-extensions/src/ledger-writer.ts`
- `packages/brewva-extensions/src/completion-guard.ts`
- `packages/brewva-extensions/src/notification.ts`

`registerScanConvergenceGuard` is intentionally registered before `registerQualityGate` so repeated scan drift is stopped before later tool-policy side effects run.

`registerLedgerWriter` additionally persists tool-output observability events:

- `tool_output_observed`
- `tool_output_artifact_persisted`
- `tool_output_distilled`

## Runtime Integration Contract

Extensions consume runtime domain APIs (for example `runtime.context.*`, `runtime.events.*`, `runtime.tools.*`) instead of legacy flat runtime methods.

Key implications:

- context injection path is async-first (`runtime.context.buildInjection(...)`)
- context pressure/compaction gate checks are delegated to `runtime.context.*`
- event writes/queries/subscriptions are delegated to `runtime.events.*`
- tool policy decisions are delegated to `runtime.tools.*`

## Context Transform Notes

`registerContextTransform` runs on `before_agent_start` and:

- appends a system-level context contract block
- injects a capability view block for progressive disclosure (compact tool list; expand with `$name`)
- injects runtime-built context via async injection path
- enforces compaction gate behavior under critical context pressure
- projects runtime routing telemetry (`skill_routing_translation` remains deterministic `skipped`; `skill_routing_semantic` mirrors runtime routing result)
- clears pending skill preselection only under the critical compaction gate path

Default context injection sources are:

- `brewva.identity`
- `brewva.truth-static`
- `brewva.truth-facts`
- `brewva.skill-candidates`
- `brewva.skill-dispatch-gate`
- `brewva.skill-cascade-gate`
- `brewva.task-state`
- `brewva.tool-failures`
- `brewva.tool-outputs-distilled`
- `brewva.projection-working`

## Runtime Core Bridge (`--no-extensions`)

`createRuntimeCoreBridgeExtension` / `registerRuntimeCoreBridge` provide a reduced extension surface when full extensions are disabled.

Retained hooks in this profile:

- `tool_call` (`registerQualityGate`) for runtime policy + compaction gate checks
- `tool_result` / `tool_execution_*` ledger persistence (`registerLedgerWriter`)
- `before_agent_start` core context block (`[CoreTapeStatus]` + autonomy contract + runtime context injection result)
- `session_compact` / `session_shutdown` lifecycle bookkeeping

Disabled full-extension hooks in this profile:

- `registerContextTransform` (`turn_start`, `context`, governance context lifecycle)
- `registerCompletionGuard`
- `registerEventStream`
- `registerNotification`

This means no-extensions keeps core safety/evidence guarantees, but omits presentation-oriented lifecycle orchestration from the full extension stack.

## Channel Bridge Notes

Channel bridge helpers (`createRuntimeChannelTurnBridge`, `createRuntimeTelegramChannelBridge`) consume channel contracts from `@brewva/brewva-runtime/channels`, not runtime root exports.
