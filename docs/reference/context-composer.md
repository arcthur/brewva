# Reference: Context Composer

Implementation anchors:

- `packages/brewva-gateway/src/runtime-plugins/context-composer.ts`
- `packages/brewva-gateway/src/runtime-plugins/context-composer-governance.ts`
- `packages/brewva-gateway/src/runtime-plugins/context-composer-supplemental.ts`
- `packages/brewva-gateway/src/runtime-plugins/hosted-context-injection-pipeline.ts`
- `packages/brewva-gateway/src/runtime-plugins/context-contract.ts`
- `packages/brewva-gateway/src/runtime-plugins/context-transform.ts` (lifecycle shell only)

## Role

`ContextComposer` is the model-facing presentation layer for already-admitted
runtime context.

This page owns block ordering and model-visible rendering only. Source
semantics for `brewva.projection-working` live in
`docs/reference/working-projection.md`, while inspect-facing baseline and
pressure metadata live on the runtime surfaces described in
`docs/reference/runtime.md`.

It does not decide:

- which sources exist
- which sources fit the budget
- which tool calls are allowed

It only decides how admitted context is shown to the model.

## Input Contract

`ContextComposer` consumes:

- `sessionId`
- current compaction-gate state
- pending compaction reason, if any
- capability-view state for the current turn
- admitted context entries from `runtime.maintain.context.buildInjection(...)`
- optional supplemental blocks from the hosted session path
- acceptance status for the injection pass

Admitted entries come from the kernel path. There is no raw-text runtime-plugin
fallback.

Hosted supplemental blocks are post-admission inputs. They are rendered by the
composer, but they are not provider-registry entries returned from
`runtime.maintain.context.buildInjection(...)`.

`buildInjection(...)` admission is now explicit about recovery-sensitive inputs:

- branch or leaf scope travels through `options.injectionScopeId`
- provider narrowing travels through `options.sourceAllowlist`
- history-view baseline compatibility is checked against
  `options.referenceContextDigest`

Hosted context profiles narrow sources before composition:

- `minimal` allows only `brewva.history-view-baseline` and
  `brewva.recovery-working-set`
- `standard` additionally allows `brewva.runtime-status`,
  `brewva.task-state`, `brewva.tool-outputs-distilled`, and
  `brewva.projection-working`
- `full` or omitted `contextProfile` installs no source allowlist, so the
  kernel provider registry decides from the full registered source set

`ContextComposer` therefore renders only the already-admitted subset for the
current hosted profile; it does not widen a minimal or standard profile back to
the full source set on its own.

This source narrowing is limited to kernel provider collection. Hosted
supplemental / recovery blocks appended after admission, such as operational
diagnostics, pending delegation outcomes, read-path recovery, skill-routing
availability, skill recommendations, and same-turn supplemental returns, do not
flow through `options.sourceAllowlist`.

## Output Contract

The composer returns ordered blocks in three categories from the admitted input
set:

- `narrative`
  - identity
  - history-view baseline
    - rewrite text only; digest, lineage, and compatibility metadata remain on
      `runtime.inspect.context`
  - hosted narrative memory
  - runtime status
  - task state
  - working projection
    - bounded rebuildable task/truth/workflow snapshot; not history rewrite
      authority
    - arrives from the admitted `brewva.projection-working` provider after
      runtime refresh; `ContextComposer` does not read
      `.orchestrator/projection/**` directly
  - hosted deliberation artifacts such as deliberation memory, optimization
    continuity, and pending promotion drafts
  - optional distilled tool output
  - same-turn supplemental return blocks
- `constraint`
  - recovery working set
  - capability summary
  - capability policy
  - optional capability inventory
  - requested capability detail
  - compaction gate or compaction advisory
- `diagnostic`
  - operational diagnostics
  - pending delegation status
  - explicit tape or observability hints when requested

Each block carries:

- `id`
- `category`
- `content`
- `estimatedTokens`

## Static Contract Boundary

Hosted `beforeAgentStart` appends one static `[Brewva Context Contract]`
suffix to the system prompt before context composition runs.

That contract is invariant. It does not carry live usage, `contextWindow`,
threshold percentages, provider-window selection, or other per-turn pressure
fields.

Current compaction pressure stays in the turn-scoped hidden tail:

- `[ContextCompactionGate]`
- `[ContextCompactionAdvisory]`
- supplemental operational diagnostics when they are useful

This keeps the Brewva-owned prompt prefix stable while leaving current pressure
guidance in the same turn-scoped composition path that already owns gate and
advisory rendering.

## Capability Rendering

Capability disclosure is derived from the semantic capability view.

Current effect vocabulary is:

- `safe`
- `effectful`

Rendered capability detail may include:

- visible-now summary
- boundary counts
- approval-required flags
- rollbackable flags
- explicit `$tool_name` detail

Compaction pressure degrades disclosure semantically rather than truncating raw
strings:

- optional inventory drops first
- compact policy/detail render before dropping requested semantics
- operational diagnostics stay last and only when useful

## Non-Goals

`ContextComposer` does not own:

- provider registration
- budget planning
- admission decisions
- replay
- hidden planning hints

Those stay in runtime services and lifecycle plumbing.

Special rule for recovery context:

- `history-view baseline` is admitted through the normal provider path, but the
  model-visible block contains only the rewrite text itself
- digest, lineage, and reference-context compatibility metadata stay on
  `runtime.inspect.context.getHistoryViewBaseline(...)`
- `working projection` stays a separate narrative block for rebuildable
  execution state; it does not backfill or widen baseline authority
- `recovery working set` remains a separate constraint block so operational
  state does not leak back into the baseline plane

Hosted deliberation reminder:

- hosted sessions may register internal sources such as
  `brewva.narrative-memory`, `brewva.deliberation-memory`,
  `brewva.optimization-continuity`, and `brewva.skill-promotion-drafts`
- these blocks are already-admitted narrative context, not new kernel
  authority
- `ContextComposer` presents them, but it does not fold, refresh, or interpret
  them into a hidden planner

Narrative-memory reminder:

- `brewva.narrative-memory` is distinct from `brewva.agent-memory`
- injected narrative recall includes provenance and freshness cues so the model
  sees it as advisory context rather than timeless truth
- repository precedent remains explicit and separate under `docs/solutions/**`

## Provider Refresh Semantics

Hosted recall providers do not share one session-start frozen snapshot.

Current provider behavior is source-specific:

- `brewva.deliberation-memory` retrieves through `plane.retrieve(...)`
- `brewva.optimization-continuity` checks lineages through `plane.list(...)`
  and injects matches through `plane.retrieve(...)`
- `brewva.skill-promotion-drafts` currently injects from `broker.listCached()`

For deliberation memory and optimization continuity, the underlying planes
reconcile derived state on demand when relevant events or session digests mark
them dirty, subject to their refresh throttles (`minRefreshIntervalMs`).

For skill-promotion drafts, the injected view can lag recent completions until
the broker refreshes its derived state.

What stays invariant is narrower:

- once a turn's context has been composed, that composed block set is fixed for
  the current turn
- later writes do not mutate an already-injected hidden message in place
- refreshed derived recall can appear on a later composition pass or later turn

Rationale:

- preserves per-turn prompt stability
- prevents reactive mutation of already-rendered model context
- keeps deliberation, continuity, and promotion sources derived and advisory
  rather than live authority channels

## Metrics

The lifecycle adapter records `context_composed` with:

- block counts by category
- total composed tokens
- narrative tokens
- narrative ratio

It intentionally does not carry prompt hashes, prompt-stability booleans, or
provider cache-token counters. Those belong to live inspect surfaces and the
existing cost summary path, not the coarse composition receipt.

This preserves the product rule:

`Model sees narrative.`
