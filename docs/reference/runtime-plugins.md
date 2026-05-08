# Reference: Runtime Plugins

Runtime plugins are the hosted turn mechanics around `BrewvaRuntime`. They may
rewrite the provider request, tool surface, tool results, and durable message
events, but they do not own model attention or replay truth.

The reset architecture is intentionally simple:

- the model owns attention through ordinary tools and the workbench notebook
- the kernel owns consequence through effect governance and receipts
- the tape owns truth through durable event replay
- the runtime owns physics: context windows, token cache shape, compaction
  pressure, and provider request compatibility

Runtime plugins remain opt-in control-plane behavior. They do not provide
cross-agent saga semantics, generalized compensation graphs, or automatic
partial-failure repair.

## Public Surface

Stable exported plugin symbols:

- `InternalRuntimePlugin`
- `InternalRuntimePluginApi`
- `RuntimePluginCapability`
- `defineInternalRuntimePlugin`
- `defineEffectInternalHostPlugin`
- `EffectInternalHostPluginApi`
- `LocalHookPort`
- `createHostedTurnPipeline`
- `TurnLifecyclePort`
- `registerTurnLifecyclePorts`
- `registerContextTransform`
- `registerEventStream`
- `registerQualityGate`
- `registerLedgerWriter`
- `registerToolResultDistiller`
- `createHostedWorkbenchContextPipeline`
- `createRuntimeTurnClockStore`
- `buildCapabilityView`
- `renderCapabilityView`

`createHostedTurnPipeline(...)` accepts the normal `BrewvaRuntimeOptions`
construction fields when it creates the runtime:

- `cwd?`
- `configPath?`
- `config?`
- `governancePort?`
- `agentId?`
- `routingScopes?`
- `routingDefaultScopes?`

Hosted factory options:

- `runtime?`
- `internalRuntimePlugins?`
- `localHooks?`
- `customTools?`
- `mcpToolSources?`
- `registerTools?`
- `orchestration?`
- `delegationStore?`
- `managedToolNames?`
- `contextProfile?`
- `ports?`
- `toolExecutionCoordinator?`
- `hostedToolDefinitionsByName?`

There is no semantic reranker sidecar in the hosted bootstrap. Additional model
calls must go through the provider gateway path that owns cost, provider
selection, and cache policy.

## Hosted Pipeline

`createHostedTurnPipeline` installs one canonical hosted spine:

1. local hooks
2. context transform
3. model-operated tool surface
4. quality gate
5. provider request reduction and recovery
6. event stream
7. ledger writer
8. tool-result distiller
9. read-path recovery

Implementation anchors:

- `packages/brewva-gateway/src/runtime-plugins/index.ts`
- `packages/brewva-gateway/src/runtime-plugins/turn-lifecycle-port.ts`
- `packages/brewva-gateway/src/runtime-plugins/event-stream.ts`
- `packages/brewva-gateway/src/runtime-plugins/ledger-writer.ts`
- `packages/brewva-gateway/src/runtime-plugins/tool-result-distiller.ts`
- `packages/brewva-gateway/src/runtime-plugins/tool-surface.ts`
- `packages/brewva-gateway/src/runtime-plugins/context-transform.ts`
- `packages/brewva-gateway/src/runtime-plugins/hosted-workbench-context-pipeline.ts`
- `packages/brewva-gateway/src/runtime-plugins/hosted-context-telemetry.ts`
- `packages/brewva-gateway/src/runtime-plugins/provider-request-reduction.ts`
- `packages/brewva-gateway/src/runtime-plugins/provider-request-recovery.ts`
- `packages/brewva-gateway/src/runtime-plugins/quality-gate.ts`
- `packages/brewva-gateway/src/host/hosted-session-bootstrap.ts`

## Tool Surface

`registerToolSurface` is model-operated. It does not require a TaskSpec, an
active skill, or a repair posture before exposing useful tools.

Resolution rules:

- all non-operator managed tools are visible by default
- operator tools require operator or meta routing scope
- `question` is hidden when the host has no UI
- exact effect governance still decides whether a tool call is allowed
- telemetry records `tool_surface_resolved` with `modelOperated: true`

The tool surface is not a stage machine. It is a visibility renderer for the
current request.

## Workbench Context

`createHostedWorkbenchContextPipeline` renders a small dynamic tail for the
provider request:

- active model-authored workbench notes
- current context status
- compacted baseline references when present

There is no `ContextSourceProvider` registry and no default prompt-injection
admission pipeline. Recall is an on-demand tool. Context providers may
materialize data for explicit tools, but they do not silently decide per-turn
attention.

## Context Profile

`contextProfile` is a rendering hint for hosted workbench context size. It does
not revive source admission, skill routing, or hidden recall selection.

The stable request shape is:

- stable system prompt
- stable managed tool definitions
- dynamic workbench/status tail
- user/provider messages

Any per-turn automatic work must justify its cache impact. Dynamic hidden
context is treated as a cost risk until proven otherwise.

## Local Hooks

`LocalHookPort` is an advisory integration surface for local policy and
inspection:

- `pre_admission`
- `pre_effect`
- `post_receipt`
- `post_rollback`
- `post_terminal`

Local hooks may annotate or block effects through declared plugin capability.
They do not become model memory and do not write replay truth unless the runtime
records an event.

## Tool Results

`registerToolResultDistiller` may reduce model-visible result payloads after the
raw tool receipt is durable. It is presentation shaping, not authority.

`registerLedgerWriter` writes durable tool execution and message summaries.
`registerEventStream` records the provider-facing lifecycle receipts used by
replay and hosted inspection.

## Removed Paths

The hosted reset deleted these old control paths:

- default context-source provider registry
- per-turn hidden recall provider
- skill-first hosted routing gate
- skill completion guard
- semantic reranker sidecar
- typed deliberation/narrative/optimization memory surfaces

These are not deprecated extension points. Reintroducing them requires a new
architecture decision and cache/cost validation.
