# Reference: Memory Formation

Implementation entrypoint:

- `packages/brewva-extensions/src/memory-formation.ts`

Supporting helpers:

- `packages/brewva-deliberation/src/cognition.ts`
- `packages/brewva-runtime/src/events/event-types.ts`

## Role

`MemoryFormation` is the write-side control-plane path for Brewva cognition
artifacts.

It does not create kernel memory. It persists non-authoritative status
summaries under `.brewva/cognition/summaries/` so later sessions can rehydrate
them through the proposal boundary.

It also persists verified procedural notes under `.brewva/cognition/reference/`
when replayable evidence shows a reusable work pattern.

## Current Triggers

Current built-in triggers:

- `agent_end`
  - write a resumable turn/session summary when the semantic snapshot changed
- `session_compact`
  - write a compacted resumable summary before the next turn starts from the
    reduced message history
- `session_shutdown`
  - write the last resumable session snapshot before runtime state is cleared
- `verification_outcome_recorded`
  - when verification passes and emits a reusable recommendation, write a
    procedural note into the `reference/` lane

## Current Output Shape

Current output is a `status_summary` artifact with fields such as:

- `summary_kind`
- `status`
- `goal`
- `phase`
- `active_skill`
- `recent_skill`
- `recent_outputs`
- `next_action`
- `blocked_on`

These fields are non-authoritative. They are meant to help future sessions
resume work, not to replace task/truth/tape state.

Current procedural output is a `ProcedureNote` artifact with fields such as:

- `note_kind`
- `lesson_key`
- `pattern`
- `recommendation`
- `verification_level`
- `active_skill`
- `failed_checks`
- `commands_executed`

These notes are still non-authoritative. They capture verified work patterns,
not kernel commitments.

## Boundary Rules

`MemoryFormation` may:

- read runtime task/skill/tape status
- inspect recent replayable runtime events
- write cognition artifacts under `.brewva/cognition/summaries/`
- emit observability events about summary persistence

`MemoryFormation` may not:

- mutate truth, task, or ledger state directly
- auto-inject artifacts into model context
- bypass `MemoryCurator` or the proposal boundary

## Current Telemetry

- `memory_summary_written`
- `memory_summary_write_failed`
- `memory_procedure_note_written`
- `memory_procedure_note_write_failed`

## Design Rule

Write-side cognition and read-side cognition stay separated:

- `MemoryFormation` decides what to persist.
- `MemoryCurator` decides what to rehydrate.
- the kernel still decides what may become visible through accepted
  `context_packet` proposals.
