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

User-facing slash-command syntax and mode-specific availability live in
`docs/reference/commands.md`. This page focuses on runtime-plugin wiring,
factory options, and port ownership.

Implementation anchors:

- `packages/brewva-cli/src/inspect-command-runtime-plugin.ts`
- `packages/brewva-cli/src/insights-command-runtime-plugin.ts`
- `packages/brewva-cli/src/questions-command-runtime-plugin.ts`
- `packages/brewva-cli/src/agent-overlays-command-runtime-plugin.ts`
- `packages/brewva-cli/src/update-command-runtime-plugin.ts`

`questions-command-runtime-plugin.ts` currently registers both `questions` and
`answer`; there is no separate `answer` runtime-plugin file.

These commands are intentionally thin. They inspect or route against durable
runtime / gateway state instead of creating a second planner or hidden task
store inside the runtime plugin layer.

They own command registration, widget lifecycle, and follow-up delivery
behavior. They do not redefine runtime read-model shapes, event payload
contracts, or durable receipt semantics.

Port reading:

- `/inspect` and `/insights` are operator products built against
  `BrewvaOperatorRuntimePort`
- hosted lifecycle adapters are built against `BrewvaHostedRuntimePort`
- the managed tool bundle is built from `BrewvaToolRuntimePort` plus explicit
  repo-owned internal hooks where needed

The port mapping above is the wiring boundary. User-facing command syntax lives
in `docs/reference/commands.md`; the underlying `inspect.*` and event
semantics live in `docs/reference/runtime.md` and
`docs/reference/events.md`.

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
- `delegationStore?`
- `managedToolNames?`
- `contextProfile?`
- `semanticReranker?`
- `ports?`
- `toolExecutionCoordinator?`
- `hostedToolDefinitionsByName?`

When `runtime` is omitted, `createHostedTurnPipeline(...)` also accepts
inherited `BrewvaRuntimeOptions` for runtime construction:

- `cwd?`
- `configPath?`
- `config?`
- `governancePort?`
- `agentId?`
- `routingScopes?`
- `routingDefaultScopes?`

When `runtime` is omitted and neither `routingScopes` nor `routingDefaultScopes`
is supplied, the hosted pipeline constructs its runtime with
`routingDefaultScopes=["core", "domain"]`. That keeps skill-first routing
available by default while still respecting an explicit
`skills.routing.enabled=true|false` decision from config.

`contextProfile` is the current hosted context-source narrowing switch:

- `minimal`
  - compiles `sourceSelection` from current provider descriptors where
    `profileSelectable=true` and `continuityCritical=true`
  - today this resolves to
    `sourceSelection={historyViewBaseline,recoveryWorkingSet}`
- `standard`
  - compiles `sourceSelection` from current provider descriptors where
    `profileSelectable=true` and `plane in {history_view, working_state}`
  - today this resolves to
    `sourceSelection={historyViewBaseline,runtimeStatus,taskState,recoveryWorkingSet,toolOutputsDistilled,projectionWorking}`
- `full`
  - disables source narrowing and lets the kernel provider registry consider
    the full admitted source set

These are explicit named selection policies over the primary-source provider
contract. They are not a second hard-coded source registry, and they are not an
open-ended automatic expansion from one metadata field.

The stable rule is:

- provider descriptors remain the only runtime-owned metadata truth
- each hosted profile compiles `sourceSelection` from those descriptors using a
  documented predicate
- adding a new provider affects `minimal` or `standard` only when that
  provider's descriptor satisfies the named policy

When `contextProfile` is omitted, the hosted pipeline behaves like `full` for
source selection: it does not install a profile allowlist ahead of
`runtime.maintain.context.buildInjection(...)`.

There are no longer legacy runtime plugin profiles such as `core` or `memory`.

## Platform-Growth Boundary

The hosted runtime-plugin package is a control-plane integration surface, not a
second transaction kernel.

Stable rule:

- the default hosted pipeline stays anchored to the current
  `single tool call` transaction boundary
- new orchestration breadth should land as opt-in control-plane behavior rather
  than widening the default hosted path
- runtime plugins may surface delegated state, route child work, or deliver
  recovery hints, but they do not create cross-agent saga semantics,
  generalized compensation graphs, or automatic partial-failure repair

If a future plugin feature needs broader multi-agent guarantees, it should
start from a focused RFC with an explicit compatibility story for events, WAL,
and host integration seams.

## Port Narrowing

`createHostedTurnPipeline()` may accept or construct a root `BrewvaRuntime`,
but runtime-plugin wiring narrows that root contract immediately:

- hosted lifecycle adapters consume `BrewvaHostedRuntimePort`
- embedded operator commands consume `BrewvaOperatorRuntimePort`
- the repo-owned managed tool bundle receives `BrewvaToolRuntimePort` plus
  explicit injected internal hooks, producing the `BrewvaBundledToolRuntime`
  used by `buildBrewvaTools()`

Raw event append does not re-enter the public runtime surface through those
ports. When hosted wiring genuinely needs raw tape append, it uses the
repository-owned internal subpath instead of widening the hosted or tool
contracts.

## Hosted Pipeline

`createHostedTurnPipeline()` wires one canonical hosted pipeline:

- `registerTurnLifecyclePorts`
- `registerEventStream`
- `registerLedgerWriter`
- `registerToolResultDistiller`
- internal bridge adapter for `tool_call` (`quality-gate`)
- internal bridge adapter for `context` (`context-transform` lifecycle shell)
- current built-in typed lifecycle handlers attach at `input`, `turnStart`,
  `beforeAgentStart`, `toolResult`, `agentEnd`, `sessionCompact`, and
  `sessionShutdown`

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
- `packages/brewva-gateway/src/runtime-plugins/provider-request-reduction.ts`
- `packages/brewva-gateway/src/runtime-plugins/provider-request-recovery.ts`
- `packages/brewva-gateway/src/runtime-plugins/quality-gate.ts`
- `packages/brewva-gateway/src/runtime-plugins/completion-guard.ts`
- `packages/brewva-gateway/src/runtime-plugins/narrative-memory-lifecycle.ts`
- `packages/brewva-gateway/src/host/hosted-session-bootstrap.ts`

There is no longer a reduced runtime-core bridge variant. Hosted sessions use
one lifecycle shape whether tools are registered by the runtime plugin API or
provided directly by the host.

The hosted pipeline therefore preserves one execution spine while still keeping
runtime access role-shaped: host lifecycle code, operator commands, and bundled
tools do not all share the same runtime view.

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

`sessionStart` remains part of the public port, but the canonical hosted
pipeline does not currently install a built-in handler there.

Intentional non-port stages:

- `tool_call` stays inside the runtime authority spine; blocking remains kernel-owned
- `tool_execution_end` is only a bridge fallback source for ledger completion
- ledger writing is a bridge adapter, not a lifecycle port

Two hosted hooks therefore stay as direct host registrations on the runtime
plugin API instead
of `TurnLifecyclePort` stages:

- `api.on("tool_call", qualityGate.toolCall)` bridges into
  `runtime.authority.tools.start()` / `ToolInvocationSpine.begin()`. This is the
  authority-owned admission point for access checks, budget checks, compaction
  gating, and effect commitment. Making it a public lifecycle port would let
  outer ports race with or override kernel authorization.
- `registerLedgerWriter(...)` bridges `tool_result` plus fallback
  `tool_execution_end` into durable runtime completion
  (`runtime.authority.tools.finish()` / `runtime.authority.tools.recordResult()`). This is finalize
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
- current TaskSpec state
- routing scopes
- explicit `$tool_name` requests

This updates only the visible surface. Runtime policy still decides whether a
tool call is actually allowed.

Current interactive protocol is TaskSpec-first:

- when no skill is active, no TaskSpec is recorded yet, and routable skills are
  available, the hosted path narrows the turn to the pre-skill bootstrap
  surface (`task_set_spec`, `task_view_state`, `workflow_status`, and related
  control-plane tools)
- after `task_set_spec`, the hosted path re-evaluates the routed skill
  candidates from TaskSpec-first intent signals rather than from raw prompt
  scoring
- when that re-evaluation changes the routed posture in the same turn, hosted
  telemetry emits a fresh `skill_recommendation_derived` receipt for the new
  posture
- only a strong post-TaskSpec match narrows the turn again so the next
  semantic decision is explicit `skill_load`

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
  - static context contract application
  - admitted provider context plus hosted supplemental / recovery block
    composition
  - delegation-outcome surfacing
  - live prompt-stability observation
  - non-durable prompt-stability evidence samples written to
    `.orchestrator/context-evidence`
- `provider-request-reduction`
  - first `before_provider_request` adapter in the hosted ring
  - clone-only transient outbound reduction for older large tool-result bodies
  - active only under high pressure and outside recovery / output-budget posture
  - pressure evaluation prefers live runtime usage, but falls back to a
    request-local payload estimate when request-time usage is missing or stale;
    the estimate reuses the current session `contextWindow` when available and
    only consults Pi model metadata when the window is otherwise unknown
  - writes live request-reduction state through
    `runtime.maintain.context.observeTransientReduction(...)`
  - records non-durable transient-reduction evidence samples in the same
    context-evidence sidecar
- `provider-request-recovery`
  - second `before_provider_request` adapter in the hosted ring
  - clone-only output-budget escalation for bounded retry paths
- `hosted-context-telemetry`
  - `context_compaction_*` and `context_composed` payload emission

The hosted runtime-plugins package also exposes
`buildContextEvidenceReport(...)` and `persistContextEvidenceReport(...)`.
These helpers aggregate:

- sidecar prompt-stability and transient-reduction samples from
  `.orchestrator/context-evidence`
- durable `message_end` summaries that preserve whether the provider explicitly
  reported `usage.cacheRead` / `usage.cacheWrite`
- durable `session_compact` receipts
- existing cost summaries for `cacheReadTokens` / `cacheWriteTokens`

The repository script `bun run report:context-evidence` wraps those helpers and
emits `report-latest.json` into the same sidecar directory. This keeps
promotion evidence outside the tape and outside `context_composed`. Stable
prefix readiness is evaluated per scope baseline: the first prompt sample in a
new hosted leaf or injection scope seeds a new baseline instead of counting as
prefix drift from the previous scope. Cache-accounting readiness is stricter
than “totals exist”: it requires explicit provider-reported cache fields plus
observed non-zero cache token totals, so zero-default summaries do not
accidentally satisfy promotion gates.

Window-derived context-pressure numbers do not live in the session-cached
system prompt contract. The hosted path keeps those fields in turn-scoped
hidden-tail composition blocks such as `[ContextCompactionGate]` and
`[ContextCompactionAdvisory]`.

Important boundary:

- `contextProfile` / `sourceSelection` narrows only kernel provider collection
  before `runtime.maintain.context.buildInjection(...)`
- hosted supplemental and recovery blocks, including operational diagnostics,
  delegation-outcome surfacing, read-path recovery, skill-routing availability,
  skill recommendations, and same-turn supplemental returns, are appended after
  admission by the hosted pipeline and are not suppressed by that provider
  selection

Transient outbound reduction is intentionally not a compaction authority. It is
a cache-class request-copy optimization: it may clear older large tool-result
bodies on the outbound provider payload, but it does not mutate durable history,
replacement history, WAL rows, compaction receipts, or `context_composed`
payloads. Request-local estimation only influences the one outbound copy; it
does not backfill or overwrite stored runtime usage telemetry.

`registerEventStream(...)` also consumes the shared turn clock to stamp durable
runtime turn numbers and clear per-session turn state on shutdown.

For reasoning continuity, `registerEventStream(...)` also owns the hosted-side
automatic checkpoint policy:

- it records automatic reasoning checkpoints at `turn_start`,
  `verification_boundary`, and `compaction_boundary`
- it does not auto-record `tool_boundary` on every tool completion; that
  boundary remains explicit
- verification-boundary checkpoints reuse the latest observed hosted leaf when
  one is available; otherwise they record `leaf=null` (the session root
  position) rather than inventing a branch target

This keeps the public hosted lifecycle contract stable while making the
experience-ring ownership model explicit.

`registerQualityGate`, `registerLedgerWriter`, and
`registerToolResultDistiller` keep the failure-and-recovery path durable:

- quality gates run on lifecycle `input`, internal `tool_call`, and lifecycle `toolResult`
- ledger writer records durable tool outcomes from `tool_result`, with
  `tool_execution_end` as the hosted fallback source
- tool-result distiller only changes the model-visible return payload after the
  raw result is already durable

`registerCompletionGuard` is a hosted UX guard around active skill completion,
not a verification gate and not a kernel authority block.

Current behavior:

- it runs on lifecycle `agentEnd`
- when a skill is still active, it sends a follow-up `brewva-guard` message
  reminding the model to call `skill_complete`
- when repair posture is active, the guard surfaces the minimum acceptable
  contract state, unresolved Tier A/B fields, the next blocking consumer, and
  the remaining repair budget instead of insisting on canonical full-schema
  retry for advisory drift
- after the per-prompt nudge budget is exhausted, it degrades to a UI warning
  instead of silently succeeding or writing a new durable authority receipt

`createNarrativeMemoryLifecycle(...)` is also part of the canonical hosted
pipeline. It records passive narrative-memory proposals from turn input and
tool evidence on lifecycle `agentEnd`; it is control-plane recall capture, not
kernel authority and not a hidden skill-routing controller.

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
