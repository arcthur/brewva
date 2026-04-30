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

## Implementation Anchors

- `packages/brewva-runtime/src/services/session-lifecycle.ts`
- `packages/brewva-runtime/src/services/session-rewind.ts`
- `packages/brewva-runtime/src/channels/recovery-wal.ts`
- `packages/brewva-runtime/src/services/session-wire.ts`
