# Session Event Families

This page covers session, turn, hosted lifecycle, session wire, rewind, and
recovery WAL events.

## Session And Turn Lifecycle

Session and turn events define the observable lifecycle of a runtime session:

- session start and shutdown
- user input and turn start/end
- render commit and assistant message completion
- hosted transition snapshots
- compaction request, compaction attempt, and compaction result

These events support replay-first inspection. They do not imply that the
runtime root object owns the full hosted session loop; the host/substrate layer
drives turns and records runtime receipts.

## Hosted Lifecycle

Hosted transition events are rebuildable lifecycle snapshots for inspection.
They summarize the current phase and recovery posture without persisting every
transient host diagnostic.

Detailed recovery history stays process-local unless it changes durable replay
or operator-visible recovery truth.

## Rewind And Recovery

Session rewind events record checkpoints, completed rewinds, redo completion,
and supersession. Recovery WAL events record pending, inflight, done, failed,
expired, recovered, and compacted posture for turn envelopes.

Use recovery events to answer:

- which turn envelope was accepted for recovery
- whether it was completed, failed, expired, or compacted
- which rewind target was selected
- whether redo restored the rewound branch tip

## Session Wire

Session wire frames are derived live protocol frames. They are useful for
frontend and hosted inspection, but the authoritative recovery record stays in
event tape, WAL state, and runtime inspect surfaces.

## Session Lineage And Context Admission

Session lineage events record work-branch topology under the session domain.
They cover lineage node creation, branch summaries, child outcomes, explicit
outcome adoption, and channel-local selection.

Context-entry events are linker records. They attach source events to a local
context-entry tree with `lineageNodeId`, `parentEntryId`, `admission`, and
`presentTo`; source message, compaction, summary, and tool-result events keep
their own event shapes.

Capability state events persist capability-owned state for reload and
inspection. They are state-only, fail-closed against declared capability
owners, and must use artifact references when inline data would exceed the
runtime payload bound.

Selection events are advisory channel state. They are replayed for inspection
and operator continuity, but authoritative writes remain self-describing with
their own lineage and context-entry identifiers.

## Implementation Anchors

- `packages/brewva-runtime/src/runtime/tape/memory-tape.ts`
- `packages/brewva-runtime/src/runtime/tape/memory-tape.ts`
- `packages/brewva-runtime/src/runtime/tape/memory-tape.ts`
- `packages/brewva-runtime/src/runtime/tape/memory-tape.ts`
- `packages/brewva-gateway/src/daemon/recovery.ts`
- `packages/brewva-gateway/src/hosted/internal/turn-adapter/turn-envelope.ts`
