# Reference: Hosted Dynamic Context

Implementation anchors:

- `packages/brewva-gateway/src/hosted/internal/context/workbench-context.ts`
- `packages/brewva-gateway/src/hosted/internal/context/hosted-context-blocks.ts`
- `packages/brewva-gateway/src/hosted/internal/context/hosted-context-support.ts`
- `packages/brewva-gateway/src/hosted/internal/context/context-contract.ts`
- `packages/brewva-gateway/src/hosted/internal/context/context-transform.ts` (lifecycle shell only)

## Role

Hosted dynamic context is the small request-local tail attached to a hosted
turn after the stable system contract. It is a renderer, not an admission
pipeline.

It exists to show the model the minimum runtime facts it cannot discover
efficiently through ordinary tools:

- numeric context status and forced-compaction state
- active model-authored workbench entries
- pending or newly completed delegation handoffs
- the previous completed turn's bounded consequence digest
- explicitly requested capability details
- bounded read-path recovery hints

It does not decide:

- which memories are worth writing
- when recall should be searched
- which tool calls are allowed
- whether effects are safe
- which files or skills the model should inspect

## Request Shape

A hosted turn has one stable request shape:

- stable system prompt plus `[Brewva Context Contract]`
- stable managed tool definitions
- one hidden dynamic tail rendered by `createHostedWorkbenchContextController`
- ordinary conversation messages and tool results

There is no `ContextSourceProvider` registry, no supplemental family registry,
no category/provenance lane model, and no per-turn context admission budget.
The runtime does not select narrative or diagnostic context for the model. The
model reads, recalls, notes, evicts, and compacts through explicit tools.

## Dynamic Blocks

The dynamic tail is a fixed ordered list. Empty blocks are omitted:

- `[ContextCompactionGate]` or `[ContextCompactionAdvisory]`
- `[Context Status]`
- `[Workbench]`
- `[PendingDelegations]`
- `[CompletedDelegationOutcomes]`
- `[TurnConsequenceDigest]` inside `turn-consequence-digest`
- requested capability detail blocks
- read-path recovery blocks

Blocks carry only `id`, `content`, and `estimatedTokens`. They do not carry
category, provenance, family id, lane reason, or retention policy.

The consequence digest is rendered from runtime inspect
`events.effects.renderTurnDigest` for the most recent completed runtime turn.
It is descriptive, not imperative, and its character budget is
`infrastructure.contextBudget.dynamicTail.consequenceDigestMaxChars`.

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

## Token-Cache Boundary

Hosted dynamic context is deliberately outside the stable Brewva-owned prefix.
It should stay small and predictable. Any new automatic per-turn block must
prove that it does not damage provider prefix-cache economics more than it
helps model quality.

Provider cache controls, prompt-cache keys, cache-break hashes, cache counters,
and cache diagnostics belong to the gateway/provider request layer and inspect
surfaces. Dynamic context telemetry records coarse block ids and token counts
only.

## Non-Goals

Hosted dynamic context does not own:

- provider registration
- context-source registration
- budget planning
- admission decisions
- replay
- hidden planning hints
- skill routing
- provider payload mutation
- recall search
