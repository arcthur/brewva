# Reference: Hosted Dynamic Context

Implementation anchors:

- `packages/brewva-substrate/src/prompt/system-prompt.ts`
- `packages/brewva-substrate/src/resources/resource-loader.ts`
- `packages/brewva-gateway/src/hosted/internal/context/workbench-context.ts`
- `packages/brewva-gateway/src/context/context-bundle.ts`
- `packages/brewva-gateway/src/hosted/internal/context/hosted-context-blocks.ts`
- `packages/brewva-gateway/src/hosted/internal/context/hosted-context-support.ts`
- `packages/brewva-gateway/src/hosted/internal/context/context-contract.ts`
- `packages/brewva-gateway/src/hosted/internal/context/context-transform.ts` (lifecycle shell only)
- `packages/brewva-cli/src/operator/inspect/context-cockpit.ts`
- `packages/brewva-gateway/src/hosted/internal/context/compaction-input-provenance.ts`

## Role

Hosted dynamic context is the small request-local tail attached to a hosted
turn after the stable system contract. It is a `ContextBundle` renderer, not a
context service or an admission pipeline.

It exists to show the model the minimum runtime facts it cannot discover
efficiently through ordinary tools:

- numeric context status and forced-compaction state
- active model-authored workbench entries
- pending or newly completed delegation handoffs
- latest replayable continuation anchor when present
- the previous completed turn's bounded consequence digest
- explicitly requested capability details
- bounded read-path recovery hints

It does not decide:

- which memories are worth writing
- when recall should be searched
- which tool calls are allowed
- whether effects are safe
- which files the model should inspect
- which unbounded recall, precedent, or extension candidate should be injected

## Request Shape

A hosted turn has one stable request shape:

- rendered `BrewvaSystemPromptDocument` blocks in canonical order: identity,
  operating contract, communication contract, tool policy, custom
  instructions, project instructions, capability selection, and environment
- an optional turn-scoped project instruction block appended from explicit
  prompt paths; missing or outside-cwd target instructions are advisory and do
  not block read, edit, or write tools
- an optional `Available Brewva SkillCards` shortlist appended by the hosted
  skill-selection lifecycle when deterministic SkillCard candidates exist
- a context-excluded `brewva-skill-selection` custom message carrying
  explicit `$skill` mentions, candidate/render/omission counts, selection id,
  prompt paths, rendered reasons, and render metadata for active-turn
  traceability; it is visible only when a shortlist is rendered or an explicit
  mention is present
- an optional `[CapabilitySelection]` section appended by the hosted tool
  surface when deterministic capability selection produces selected,
  forbidden, or policy evidence
- stable managed tool definitions
- one hidden dynamic tail rendered by `createHostedWorkbenchContextController`
- ordinary conversation messages and tool results

Attention options are not a hidden dynamic-tail admission source. The baseline
request may include bounded facts such as the current request, project guidance,
target roots, capability posture, diff posture, latest continuation anchor, and
context pressure. Unbounded or cross-session evidence is exposed as option
cards and only enters the answer path when the model consumes or pins it.

`Available Brewva SkillCards` and `[CapabilitySelection]` are not part of the
dynamic-tail renderer. `Available Brewva SkillCards` is an advisory
prompt-context view backed by `skill_selection_recorded` and a hidden
trace-only message.
`[CapabilitySelection]` is a system-prompt authority view backed by a durable
capability-selection receipt. The two sections are physically separate so
SkillCards cannot grant tools, accounts, budgets, or runtime authority.

There is no `ContextSourceProvider` registry, no supplemental family registry,
no category/provenance lane model, and no per-turn context admission service.
The runtime does not select narrative or diagnostic context for the model. The
model reads, recalls, notes, evicts, and compacts through explicit tools.

## Dynamic Blocks

The dynamic tail is a fixed ordered list. Empty blocks are omitted:

- `[ContextCompactionGate]` or `[ContextCompactionAdvisory]`
- `[Context Status]`
- `[LatestContinuationAnchor]`
- `[Workbench]`
- `[PendingDelegations]`
- `[CompletedDelegationOutcomes]`
- `[TurnConsequenceDigest]` inside `turn-consequence-digest`
- requested capability detail blocks
- read-path recovery blocks

Block producers still emit simple hosted context blocks, but the final
composition step converts them into an immutable serializable `ContextBundle`.
The bundle is a value record with:

- `schema`, `bundleId`, `scope`, `hash`, and `createdAt`
- `sourceRefs` and `admittedRefs`
- admitted `blocks`
- `budget` and `totalTokens`

`ContextBundle` is not a service. It has no hidden telemetry hooks, no mutable
cursor, and no runtime-owned registry. The same value shape is used by hosted
tail rendering, delegation prompts, fork context, and detached background
manifests.

Admission is deterministic:

- required blocks are considered before advisory blocks
- advisory blocks are dropped by ascending priority when the budget is tight
- only blocks that declare deterministic truncation may be truncated
- required overflow returns a typed blocker:
  - hosted dynamic context maps it to a compaction requirement
  - delegation prompt construction maps it to an admission blocker

Blocks do not carry category, provenance family, lane reason, or retention
policy beyond explicit source references.

The consequence digest is rendered from runtime inspect
`events.effects.renderTurnDigest` for the most recent completed runtime turn.
It is descriptive, not imperative, and its character budget is
`infrastructure.contextBudget.consequenceDigestMaxChars`.

Compaction gate/advisory blocks are nudge-throttled per session. The first
appearance of a stable gate/advisory state is rendered in full; repeated
appearances use a terse action line, with periodic full reminders. This keeps
the dynamic tail small and cache-stable while still telling the model when the
runtime physics require or advise `workbench_compact`.

## Workbench Boundary

Workbench entries are model-authored notebook entries written through:

- `workbench_note`
- `workbench_evict`
- `workbench_undo_evict`

Compaction commits the next baseline. Before that baseline, evictions are
locally reversible. After baseline, replay uses the stored sanitized compact
summary by digest; replay never regenerates the summary with a newer model.

Recall results enter the request only when the model calls `recall_search` and
then chooses to use them in the answer path or preserve them in the workbench.
Recall is not a per-turn admission source.

## Context Cockpit

`brewva inspect`, the shell inspect overlay, and slash `/inspect` expose a
context cockpit projection for operators. The cockpit is read-only and
operator-visible: it reads runtime ports, event receipts, latest evidence, and
existing projections, but it does not call context materialization, recall
search, capability selection, provider routing, or workbench mutation.

The cockpit shows context status, active workbench entries, advisory skill
invocation records, surfaced SkillCard resource refs, capability receipts,
surfaced recall result provenance, compact baseline provenance, and normalized
provider cache posture. Opening it must not change event counts or the next
model attention input for the same session evidence.

## Token-Cache Boundary

Hosted dynamic context is deliberately outside the stable Brewva-owned prefix.
It should stay small and predictable. Any new automatic per-turn block must
enter through a block producer plus `buildContextBundle(...)`, and must prove
that it does not damage provider prefix-cache economics more than it helps
model quality.

Provider cache controls, prompt-cache keys, cache-break hashes, cache counters,
and cache diagnostics belong to the gateway/provider request layer and inspect
surfaces. Dynamic context telemetry records coarse block ids and token counts
only.

`buildContextBundle(...)` and `buildContextMaterializationReceipt(...)` are
pure. The hosted lifecycle caller is the single receipt-to-effect runner for
usage observation, context-composed telemetry, prompt-stability evidence, and
marking surfaced delegation outcomes.

## Non-Goals

Hosted dynamic context does not own:

- provider registration
- context-source registration
- budget planning
- admission decisions
- replay
- hidden planning hints
- skill authority routing
- provider payload mutation
- recall search
