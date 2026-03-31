# Reference: Runtime Plugins

Runtime plugin package: `@brewva/brewva-gateway/runtime-plugins`
(`packages/brewva-gateway/src/runtime-plugins/index.ts`).

## Terminology

- Hosted pipeline: the canonical gateway lifecycle integration layer registered into a hosted session
- Runtime plugin: the canonical Brewva hosted session integration unit; implemented on top of the upstream `ExtensionFactory` contract
- Runtime plugin implementation: one implementation file under `packages/brewva-gateway/src/runtime-plugins`

`registerTools: false` keeps the hosted pipeline but disables managed-tool
registration through the runtime plugin API.

## Default Interactive Command Plugins

The embedded CLI currently layers these operator commands on top of the hosted
pipeline:

- `inspect`
- `insights`
- `questions`
- `answer`
- `agent-overlays`
- `update`

Implementation anchors:

- `packages/brewva-cli/src/inspect-command-runtime-plugin.ts`
- `packages/brewva-cli/src/insights-command-runtime-plugin.ts`
- `packages/brewva-cli/src/questions-command-runtime-plugin.ts`
- `packages/brewva-cli/src/agent-overlays-command-runtime-plugin.ts`
- `packages/brewva-cli/src/update-command-runtime-plugin.ts`

These commands are intentionally thin. They inspect or route against durable
runtime / gateway state instead of creating a second planner or hidden task
store inside the runtime plugin layer.

## Factory API

- `RuntimePlugin`
- `RuntimePluginApi`
- `createHostedTurnPipeline`
- `TurnLifecyclePort`
- `registerTurnLifecyclePorts`

`RuntimePluginApi` is the upstream event/tool registration object passed into a
runtime plugin at host bootstrap.

Current factory option surface:

- `runtime?`
- `runtimePlugins?` on `createHostedSession(...)` / `createBrewvaSession(...)` for composing additional runtime plugins alongside the canonical hosted pipeline
- `registerTools?` (default `true`)
- `orchestration?`
- `managedToolNames?`
- `ports?`

When `runtime` is omitted, `createHostedTurnPipeline(...)` also accepts
inherited `BrewvaRuntimeOptions` for runtime construction:

- `cwd?`
- `configPath?`
- `config?`
- `governancePort?`
- `agentId?`
- `routingScopes?`

There are no longer public runtime plugin profiles such as `core`, `memory`, or
`full`.

## Hosted Pipeline

`createHostedTurnPipeline()` wires one canonical hosted pipeline:

- `registerTurnLifecyclePorts`
- `registerEventStream`
- `registerLedgerWriter`
- `registerToolResultDistiller`
- internal bridge adapter for `tool_call` (`quality-gate`)
- internal bridge adapter for `context` (`context-transform` lifecycle shell)
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
- `packages/brewva-gateway/src/runtime-plugins/hosted-compaction-controller.ts`
- `packages/brewva-gateway/src/runtime-plugins/hosted-context-injection-pipeline.ts`
- `packages/brewva-gateway/src/runtime-plugins/hosted-context-telemetry.ts`
- `packages/brewva-gateway/src/runtime-plugins/context-composer.ts`
- `packages/brewva-gateway/src/runtime-plugins/context-contract.ts`
- `packages/brewva-gateway/src/runtime-plugins/quality-gate.ts`
- `packages/brewva-gateway/src/runtime-plugins/completion-guard.ts`
- `packages/brewva-gateway/src/host/hosted-session-bootstrap.ts`

There is no longer a reduced runtime-core bridge variant. Hosted sessions use
one lifecycle shape whether tools are registered by the runtime plugin API or
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

Two hosted hooks therefore stay as direct host registrations on the runtime
plugin API instead
of `TurnLifecyclePort` stages:

- `api.on("tool_call", qualityGate.toolCall)` bridges into
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

`registerContextTransform` is now a thin lifecycle shell inside a hosted
pipeline that also wires one shared `RuntimeTurnClockStore` into the hosted
adapter stack.

The hosted context path is split across these explicit adapters:

- `hosted-compaction-controller`
  - consumes the shared turn clock for compaction-facing turn state
  - auto-compaction watchdog and idle-vs-active policy
  - `context`, `sessionCompact`, and `sessionShutdown` reactions
- `hosted-context-injection-pipeline`
  - `beforeAgentStart` orchestration
  - context contract application
  - admitted context + supplemental block composition
  - delegation-outcome surfacing
- `hosted-context-telemetry`
  - `context_compaction_*` and `context_composed` payload emission

`registerEventStream(...)` also consumes the shared turn clock to stamp durable
runtime turn numbers and clear per-session turn state on shutdown.

This keeps the public hosted lifecycle contract stable while making the
experience-ring ownership model explicit.

`registerQualityGate`, `registerLedgerWriter`, and
`registerToolResultDistiller` keep the failure-and-recovery path durable:

- quality gates run on lifecycle `input`, internal `tool_call`, and lifecycle `toolResult`
- ledger writer records durable tool outcomes from `tool_result`, with
  `tool_execution_end` as the hosted fallback source
- tool-result distiller only changes the model-visible return payload after the
  raw result is already durable

`registerCompletionGuard` keeps completion model-native but not lax. It blocks
premature completion when required verification has not passed.

## Event Surface Split

Hosted sessions intentionally separate live activity from durable audit
records.

Live-only stream behavior:

- `message_update` stays in the hosted session stream only
- `tool_execution_update` stays in the hosted session stream only
- assistant text/thinking deltas are not appended to the durable tape

Durable summary behavior:

- `message_end` carries the durable assistant-message summary plus health
  metrics
- `tool_execution_end` carries the durable execution outcome summary
- durable tape starts at admitted runtime activity and governance receipts
  rather than a separate provider-normalization family

This keeps replay and evidence surfaces stable while allowing high-frequency UI
feedback in hosted channels.

## Removed Layers

The hosted pipeline no longer includes:

- dual factory paths
- runtime-core bridge profiles
- planner-shaped recovery adapters
- hidden delegation suggestions
- stateful cognition adapters
- presentation-only notification layers

Those layers were removed instead of hidden behind profile toggles or legacy
compatibility seams.
