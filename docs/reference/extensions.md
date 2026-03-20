# Reference: Extensions

Extension factory entrypoint: `@brewva/brewva-gateway/runtime-plugins`
(`packages/brewva-gateway/src/runtime-plugins/index.ts`).

## Terminology

- Extension: the gateway lifecycle integration layer registered into a hosted session
- Runtime plugin: one implementation file under `packages/brewva-gateway/src/runtime-plugins`

`--no-extensions` disables the full extension stack while keeping the reduced
runtime-core bridge.

## Factory API

- `createBrewvaExtension`
- `brewvaExtension`
- `createRuntimeCoreBridgeExtension`

Current factory option surface:

- `runtime?`
- `registerTools?` (default `true`)
- `orchestration?`
- `managedToolNames?`

There are no longer public extension profiles such as `core`, `memory`, or
`full`.

## Default Hosted Path

`createBrewvaExtension()` wires one fixed lifecycle stack:

- `registerEventStream`
- `registerLedgerWriter`
- `registerToolResultDistiller`
- `registerToolSurface`
- `registerContextTransform`
- `registerQualityGate`
- `registerCompletionGuard`

Implementation anchors:

- `packages/brewva-gateway/src/runtime-plugins/index.ts`
- `packages/brewva-gateway/src/runtime-plugins/event-stream.ts`
- `packages/brewva-gateway/src/runtime-plugins/ledger-writer.ts`
- `packages/brewva-gateway/src/runtime-plugins/tool-result-distiller.ts`
- `packages/brewva-gateway/src/runtime-plugins/tool-surface.ts`
- `packages/brewva-gateway/src/runtime-plugins/context-transform.ts`
- `packages/brewva-gateway/src/runtime-plugins/context-composer.ts`
- `packages/brewva-gateway/src/runtime-plugins/context-contract.ts`
- `packages/brewva-gateway/src/runtime-plugins/quality-gate.ts`
- `packages/brewva-gateway/src/runtime-plugins/completion-guard.ts`

The reduced path uses `createRuntimeCoreBridgeExtension()` instead. It keeps
the runtime safety spine without the full presentation lifecycle.

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

- quality gates run on `input` and `tool_call`
- ledger writer records durable tool outcomes
- tool-result distiller only changes the model-visible return payload after the
  raw result is already durable

`registerCompletionGuard` keeps completion model-native but not lax. It blocks
premature completion when required verification has not passed.

## Removed Layers

The default extension path no longer includes:

- planner-shaped recovery adapters
- hidden delegation suggestions
- stateful cognition adapters
- presentation-only notification layers

Those layers were removed instead of hidden behind profile toggles.

Legacy note:

- `registerNotification` existed on the older hosted-session path but is no
  longer part of the current default extension stack.
