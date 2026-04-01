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
- admitted context entries from `runtime.context.buildInjection(...)`
- optional supplemental blocks from the hosted session path
- acceptance status for the injection pass

Admitted entries come from the kernel path. There is no raw-text runtime-plugin
fallback.

## Output Contract

The composer returns ordered blocks in three categories:

- `narrative`
  - identity
  - hosted narrative memory
  - runtime status
  - task state
  - working projection
  - hosted deliberation artifacts such as deliberation memory, optimization
    continuity, and pending promotion drafts
  - optional distilled tool output
  - same-turn supplemental return blocks
- `constraint`
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

## Frozen Snapshot Invariant

Deliberation memory, optimization continuity, and skill promotion context
providers use cached state (`retrieveCached`, `listCached`) during context
collection. State is synced once during session setup by the hosted lifecycle
adapter, then frozen for the remainder of the session.

This is intentional. Mid-session writes such as new skill completions,
verification outcomes, or iteration facts update the durable store on disk but
do not change the context snapshot that was injected at session start. The
snapshot refreshes on the next session.

Rationale:

- preserves prompt cache stability across the full session
- prevents context oscillation from mid-turn event activity
- matches the design principle that deliberation memory is derived and
  advisory, not a live authority channel

This pattern follows the same discipline as Brewva's existing context injection
model: sources are admitted once per turn via the deterministic injection path,
not reactively mutated mid-conversation.

## Metrics

The lifecycle adapter records `context_composed` with:

- block counts by category
- total composed tokens
- narrative tokens
- narrative ratio

This preserves the product rule:

`Model sees narrative.`
