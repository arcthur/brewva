# Reference: Context Composer

Implementation entrypoints:

- `packages/brewva-gateway/src/runtime-plugins/context-composer.ts`
- `packages/brewva-gateway/src/runtime-plugins/context-transform.ts`
- `packages/brewva-gateway/src/runtime-plugins/context-contract.ts`

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
- optional supplemental blocks from the hosted-session path
- acceptance status for the injection pass

Admitted entries come from the kernel path. There is no raw-text extension
fallback.

## Output Contract

The composer returns ordered blocks in three categories:

- `narrative`
  - identity
  - runtime status
  - task state
  - working projection
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

## Metrics

The lifecycle adapter records `context_composed` with:

- block counts by category
- total composed tokens
- narrative tokens
- narrative ratio

This preserves the product rule:

`Model sees narrative.`
