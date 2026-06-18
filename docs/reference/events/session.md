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

Hosted provider credential rotation is recorded as a redacted lifecycle event
named `provider_credential_rotated`. Its payload is exactly
`{ providerId, credentialSlot, reason, cooldownMs }`, where `reason` is
`"quota" | "rate_limit" | "auth" | "manual"`. It records the selected slot and
cooldown policy only; provider secrets and credential values are forbidden.

## Rewind And Recovery

Session rewind events record checkpoints, completed rewinds, redo completion,
and supersession. Recovery WAL emits `recovery.wal.appended`,
`recovery.wal.status.changed`, `recovery.wal.compacted`, and
`recovery.wal.recovery.completed`; the `status.changed` payload carries row
posture (`pending`, `inflight`, `done`, `failed`, `expired`, `recovered`,
`compacted`).

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

The interactive `/tree` surface is a projection over these context-entry
records. It does not introduce a new runtime root, session-index truth source,
or hidden memory plane. Tree checkout records through the same lineage
selection and branch-summary event paths used by other session lifecycle
operations.

Branch carry summaries may include an `activeSummaryKey` in their event
details. The summary body carries bounded textual continuity from the abandoned
branch path; abandoned entries are not copied into the new path as raw replay
messages. Context materialization uses that key to keep the latest active carry
summary for a fork point and applies the branch-summary context budget at read
time; the tape record itself remains unchanged and inspectable.

Capability state events persist capability-owned state for reload and
inspection. They are state-only, fail-closed against declared capability
owners, and must use artifact references when inline data would exceed the
runtime payload bound.

Selection events are advisory channel state. They are replayed for inspection
and operator continuity, but authoritative writes remain self-describing with
their own lineage and context-entry identifiers.

## Implementation Anchors

- `packages/brewva-runtime/src/runtime/tape/impl.ts`
- `packages/brewva-runtime/src/runtime/tape/impl.ts`
- `packages/brewva-runtime/src/runtime/tape/impl.ts`
- `packages/brewva-runtime/src/runtime/tape/impl.ts`
- `packages/brewva-gateway/src/daemon/recovery.ts`
- `packages/brewva-gateway/src/hosted/internal/turn-adapter/turn-envelope.ts`
