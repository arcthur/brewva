# Reference: Memory Formation

Implementation core:

- `packages/brewva-deliberation/src/memory-formation.ts`

Gateway lifecycle adapter:

- `packages/brewva-gateway/src/runtime-plugins/memory-formation.ts`

Supporting helpers:

- `packages/brewva-deliberation/src/cognition.ts`
- `packages/brewva-runtime/src/events/event-types.ts`

## Role

`MemoryFormation` is the write-side control-plane path for Brewva cognition
artifacts.

It does not create kernel memory. It persists non-authoritative status
summaries under `.brewva/cognition/summaries/` so later sessions can rehydrate
them through the proposal boundary.

## Current Triggers

Current built-in triggers are:

- `agent_end`
- `session_compact`
- `session_shutdown`

Each trigger writes only when the semantic summary changed for the current
session.

## Current Output Shape

Current output is a single `status_summary` artifact with fields such as:

- `session_scope`
- `summary_kind`
- `status`
- `goal`
- `phase`
- `health`
- `active_skill`
- `recent_skill`
- `recent_outputs`
- `blocked_on`

These fields are non-authoritative. They help later sessions resume work, but
they do not replace task, truth, or tape state.

There is no default episode or procedure formation path anymore.

## Telemetry

- `memory_summary_written`
- `memory_summary_write_failed`

## Boundary Rules

`MemoryFormation` may:

- read runtime task and skill status
- inspect recent replayable runtime events
- write cognition summaries under `.brewva/cognition/summaries/`
- emit observability events about summary persistence

`MemoryFormation` may not:

- mutate truth, task, or ledger state directly
- auto-inject artifacts into model context
- bypass `MemoryCurator` or the proposal boundary

## Design Rule

Default write-side cognition is intentionally summary-only. The aim is to keep
resumability useful without rebuilding a second authority layer or a large
memory taxonomy.
