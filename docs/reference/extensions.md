# Reference: Extensions

Extension factory entrypoint: `@brewva/brewva-gateway/runtime-plugins`
(`packages/brewva-gateway/src/runtime-plugins/index.ts`).

## Terminology

- Hosted pipeline: the canonical gateway lifecycle integration layer registered into a hosted session
- Runtime plugin: one implementation file under `packages/brewva-gateway/src/runtime-plugins`

`registerTools: false` keeps the hosted pipeline but disables managed-tool
registration through the extension factory.

## Factory API

- `createHostedTurnPipeline`
- `TurnLifecyclePort`
- `registerTurnLifecyclePorts`

Current factory option surface:

- `runtime?`
- `registerTools?` (default `true`)
- `orchestration?`
- `managedToolNames?`
- `ports?`

There are no longer public extension profiles such as `core`, `memory`, or
`full`.

## Hosted Pipeline

`createHostedTurnPipeline()` wires one canonical hosted pipeline:

- `registerTurnLifecyclePorts`
- `registerEventStream`
- `registerLedgerWriter`
- `registerToolResultDistiller`
- internal bridge adapter for `tool_call` (`quality-gate`)
- internal bridge adapter for `context` (`context-transform`)
- typed lifecycle ports for `input`, `turnStart`, `beforeAgentStart`, `toolResult`,
  `agentEnd`, `sessionCompact`, and `sessionShutdown`

Implementation anchors:

- `packages/brewva-gateway/src/runtime-plugins/index.ts`
- `packages/brewva-gateway/src/runtime-plugins/turn-lifecycle-port.ts`
- `packages/brewva-gateway/src/runtime-plugins/event-stream.ts`
- `packages/brewva-gateway/src/runtime-plugins/ledger-writer.ts`
- `packages/brewva-gateway/src/runtime-plugins/tool-result-distiller.ts`
- `packages/brewva-gateway/src/runtime-plugins/tool-surface.ts`
- `packages/brewva-gateway/src/runtime-plugins/context-transform.ts`
- `packages/brewva-gateway/src/runtime-plugins/context-composer.ts`
- `packages/brewva-gateway/src/runtime-plugins/context-contract.ts`
- `packages/brewva-gateway/src/runtime-plugins/quality-gate.ts`
- `packages/brewva-gateway/src/runtime-plugins/completion-guard.ts`

There is no longer a reduced runtime-core bridge profile. Hosted sessions use
one lifecycle shape whether tools are registered by the extension factory or
provided directly by the host.

## Turn Lifecycle Port

`TurnLifecyclePort` is the public experience/control-plane contract. Stages:

- `sessionStart`
- `turnStart`
- `input`
- `beforeAgentStart`
- `toolResult`
- `agentEnd`
- `sessionCompact`
- `sessionShutdown`

Intentional non-port stages:

- `tool_call` stays inside the runtime authority spine; blocking remains kernel-owned
- `tool_execution_end` is only a bridge fallback source for ledger completion
- ledger writing is a bridge adapter, not a lifecycle port

Two hosted hooks therefore stay as direct Pi registrations instead of
`TurnLifecyclePort` stages:

- `pi.on("tool_call", qualityGate.toolCall)` bridges into
  `runtime.tools.start()` / `ToolInvocationSpine.begin()`. This is the
  authority-owned admission point for access checks, budget checks, compaction
  gating, and effect commitment. Making it a public lifecycle port would let
  outer ports race with or override kernel authorization.
- `registerLedgerWriter(...)` bridges `tool_result` plus fallback
  `tool_execution_end` into durable runtime completion
  (`runtime.tools.finish()` / `runtime.tools.recordResult()`). This is finalize
  plumbing, not presentation shaping, so it remains a bridge adapter rather
  than a port stage.

The public `toolResult` lifecycle stage is therefore intentionally narrower: it
is for post-authority, model-facing shaping after the raw outcome is already
durable.

## Tool Surface Resolution

`registerToolSurface` runs before agent start and narrows the visible tool list
for the current turn.

Resolution inputs:

- always-on base tools
- managed Brewva tools plus exact governance metadata
- current skill execution hints
- routing scopes
- explicit `$tool_name` requests

This updates only the visible surface. Runtime policy still decides whether a
tool call is actually allowed.

Telemetry:

- `tool_surface_resolved`

## Context And Recovery

`registerContextTransform` owns model-facing context shaping:

- apply the Brewva context contract
- compose admitted kernel context plus supplemental blocks
- render capability disclosure
- surface compaction guidance

`registerQualityGate`, `registerLedgerWriter`, and
`registerToolResultDistiller` keep the failure-and-recovery path durable:

- quality gates run on lifecycle `input`, internal `tool_call`, and lifecycle `toolResult`
- ledger writer records durable tool outcomes from `tool_result`, with
  `tool_execution_end` as the hosted fallback source
- tool-result distiller only changes the model-visible return payload after the
  raw result is already durable

`registerCompletionGuard` keeps completion model-native but not lax. It blocks
premature completion when required verification has not passed.

## Removed Layers

The hosted pipeline no longer includes:

- dual factory paths
- runtime-core bridge profiles
- planner-shaped recovery adapters
- hidden delegation suggestions
- stateful cognition adapters
- presentation-only notification layers

Those layers were removed instead of hidden behind profile toggles or
compatibility aliases.
