# Research: Turn Lifecycle Spine

## Document Metadata

- Status: `promoted`
- Owner: runtime and gateway maintainers
- Last reviewed: `2026-04-29`
- Promotion target:
  - `docs/architecture/system-architecture.md`
  - `docs/architecture/control-and-data-flow.md`
  - `docs/architecture/invariants-and-reliability.md`
  - `docs/reference/session-lifecycle.md`
  - `docs/reference/runtime.md`
  - `docs/reference/events.md`
  - `docs/reference/gateway-control-plane-protocol.md`
  - `docs/journeys/internal/context-and-compaction.md`

## Promotion Summary

This note is now a promoted status pointer.

The accepted decision is:

- `TurnLifecycleSpine` is the internal gate-ordering model for one accepted
  hosted turn.
- the stable gate order is
  `ingress_received -> admission_resolved -> effect_authorized -> execution_recorded -> recovery_settled -> terminal_recorded`.
- the spine is monotonic. Duplicate advancement to the current gate is a no-op;
  backward advancement or backward recovery supersession is an assertion
  failure.
- one spine covers one ingress-to-terminal hosted turn. Multiple model/tool
  iterations inside that turn do not restart the spine.
- hydration folds remain federated but declare the gates they observe.
- hosted transitions remain durable/rebuildable gateway receipts, but they
  project the spine rather than defining a rival lifecycle.
- recovery supersession advances spine posture only. It never rewrites, deletes,
  or reinterprets prior tape events.
- `effect_authorized` is advanced from the manifest-backed
  `effect_authority_decided` receipt; `execution_recorded` is advanced from
  `tool_result_recorded`.
- the `superseded` field is a historical marker for the turn, meaning trusted
  recovery supersession occurred at least once during that turn. It is not a
  separate active mode that clears after terminal output.

## Stable References

- `docs/architecture/system-architecture.md`
- `docs/architecture/control-and-data-flow.md`
- `docs/architecture/invariants-and-reliability.md`
- `docs/reference/session-lifecycle.md`
- `docs/reference/runtime.md`
- `docs/reference/gateway-control-plane-protocol.md`
- `docs/journeys/internal/context-and-compaction.md`

## Current Implementation Notes

Implemented anchors:

- `packages/brewva-runtime/src/lifecycle/turn-lifecycle-spine.ts`
- `packages/brewva-gateway/src/session/turn-envelope.ts`
- `packages/brewva-gateway/src/session/turn-transition.ts`
- `test/unit/runtime/turn-lifecycle-spine.unit.test.ts`
- `test/unit/gateway/turn-envelope.unit.test.ts`

Declared fold placement now lives beside the spine implementation so the
registry and documentation share the same source vocabulary. Declared recovery
placement covers WAL resume, reasoning revert resume, compaction retry,
provider fallback, max-output recovery, rollback receipts, and terminal
shutdown.

This change co-landed with
`docs/research/promoted/rfc-effect-authority-manifest.md`. The spine only orders
turn gates. The manifest remains the authority owner for the
`effect_authorized` gate, and existing tape receipts remain the replay
authority for recovery.

## Validation Status

Promotion is backed by:

- unit coverage for monotonic gate advancement and non-monotonic recovery
  supersession rejection
- unit coverage for declared fold placement and declared recovery placement
- gateway envelope coverage proving manifest and tool-result receipts advance
  the spine and WAL recovery projects through `wal_recovery_resume`
- stable docs that distinguish turn gates from
  `SessionLifecycleSnapshot.summary`, host `SessionPhase`, and
  `session_turn_transition`

## Non-Goals

- Replacing `SessionLifecycleSnapshot`.
- Replacing federated hydration folds with one reducer.
- Creating a public lifecycle subscription or status surface.
- Adding an `approval_waiting` spine gate. Approval suspension remains modeled
  through existing approval receipts, thread-loop suspension, and session
  lifecycle summary projection.
- Rewriting `HostedThreadLoop`.
- Moving the kernel transaction boundary above one tool call.
- Adding cross-agent saga or compensation semantics.
- Splitting `runtime.ts`; runtime assembly cleanup remains ordinary follow-on
  maintainability work.

## Closed Implementation Posture

This RFC has no remaining open design questions. Future lifecycle work should
attach to the declared turn gates or start a new focused RFC when it needs a new
public surface, persisted event family, or transaction boundary.
