# Research: Session Rewind As A Conversation-Fork Primitive

## Document Metadata

- Status: `promoted`
- Owner: runtime and CLI maintainers
- Last reviewed: `2026-04-28`
- Promotion target:
  - `docs/architecture/control-and-data-flow.md`
  - `docs/architecture/invariants-and-reliability.md`
  - `docs/reference/runtime.md`
  - `docs/reference/events.md`
  - `docs/reference/session-lifecycle.md`
  - `docs/journeys/operator/inspect-replay-and-recovery.md`
  - `docs/guide/cli.md`

## Promotion Summary

This note is now a promoted status pointer.

The accepted decision is:

- Brewva treats session rewind as a conversation-fork transaction, not as a
  transcript edit or a filesystem snapshot shortcut.
- `/undo`, `/rewind`, and `/redo` share the same `SessionRewindService` rewind
  state machine. `/undo` targets the latest active checkpoint and carries
  summary by default; `/rewind` can target an active-lineage checkpoint and
  defaults to a clean fork.
- Rewind composes durable reasoning checkpoints/reverts with receipt-backed
  patch rollback. Conversation-only, code-only, and full rewind modes are
  explicit product choices.
- Rewind and redo events store reasoning receipt identifiers only. Replay
  hydrates public rewind state by joining those ids to the underlying
  `reasoning_checkpoint` and `reasoning_revert` receipts on the same tape.
  Embedded reasoning records are intentionally not a compatibility surface.
- The runtime owns a shared session-rewind projector. Runtime inspection and
  the DuckDB session-index mirror use the same projector semantics, so active
  lineage, abandoned checkpoints, patch counts, and redo state do not drift.

Stable implementation now includes:

- `runtime.authority.session.recordRewindCheckpoint(...)`
- `runtime.authority.session.rewind(...)`
- `runtime.authority.session.redo(...)`
- `runtime.inspect.session.getRewindState(...)`
- `runtime.inspect.session.listRewindTargets(...)`
- `/undo`, `/redo`, and `/rewind` interactive CLI entrances
- active-lineage patch scoping after abandoned branches
- streaming guards at the runtime API boundary
- mode-aware governance for `conversation`, `code`, and `both`
- id-only rewind and redo payloads with reasoning receipt hydration on replay
- a rebuildable `session_rewind_targets` DuckDB mirror for session-index
  consumers

Stable references:

- `docs/architecture/control-and-data-flow.md`
- `docs/architecture/invariants-and-reliability.md`
- `docs/reference/runtime.md`
- `docs/reference/events.md`
- `docs/reference/session-lifecycle.md`
- `docs/journeys/operator/inspect-replay-and-recovery.md`
- `docs/guide/cli.md`

## Stable Contract Summary

The promoted contract is:

1. One transaction engine owns rewind state.
   `SessionRewindService` remains the only writer for session rewind checkpoints,
   rewind completions, redo completions, and redo-stack supersession.
2. Active lineage is authoritative.
   Rewind targets and patch rollback scope are computed from the active
   reasoning lineage. Patch events from abandoned branches do not participate
   in later rollback windows.
3. Tape stores references, not embedded branch records.
   Session rewind events carry receipt ids and event ids. The reasoning tape
   remains the source of truth for reasoning records.
4. Runtime APIs are guarded while turns are active.
   Rewind and redo reject non-idle sessions before mutating reasoning or
   workspace state.
5. Governance is mode-aware and fail-closed.
   Conversation-only rewind requires the session/control mutation policy.
   Code and full rewind require both session/control mutation and workspace
   write effects.
6. Picker state is a projection, not transcript scraping.
   The picker consumes `SessionRewindTargetView` from the runtime read model.
   Session-index stores the same target shape as a rebuildable DuckDB mirror
   for ad-hoc query consumers.

## Validation Status

Promotion is backed by:

- runtime contract coverage for rewind, redo, active-lineage patch scoping,
  streaming rejection, governance rejection, failure compensation, and replay
  hydration from reasoning receipt ids
- CLI contract and shell unit coverage for `/undo`, `/redo`, `/rewind`,
  picker target selection, composer refill, and status rendering
- session-index coverage proving that `session_rewind_targets` materializes
  the same target view as runtime inspection
- gateway recovery coverage for id-only rewind payloads and clean fork resume
- repository verification via `bun run check` and `bun test`

## Source Anchors

- `packages/brewva-runtime/src/services/session-rewind.ts`
- `packages/brewva-runtime/src/projection/session-rewind.ts`
- `packages/brewva-runtime/src/runtime-method-groups.ts`
- `packages/brewva-runtime/src/governance/action-policy.ts`
- `packages/brewva-runtime/src/events/event-types.ts`
- `packages/brewva-runtime/src/contracts/session.ts`
- `packages/brewva-session-index/src/index.ts`
- `packages/brewva-cli/src/shell/flows/session-workflow.ts`
- `packages/brewva-cli/src/shell/adapters/ports.ts`
- `packages/brewva-gateway/src/session/reasoning-revert-recovery.ts`
- `packages/brewva-gateway/src/host/runtime-projection-session-store.ts`

## Remaining Backlog

The following areas remain intentionally outside the promoted core:

- a dedicated channel or Telegram rewind product surface
- direct model-callable managed tool exposure for session rewind
- a double-Esc binding if the current keybinding layer cannot represent the
  chord cleanly
- future visualization of abandoned branches beyond inspect and picker views

If those areas become priorities, they should start from a new focused RFC
rather than reopening this promoted status pointer.

## Historical Notes

- the original active RFC compared Brewva's design to Claude Code's `/rewind`
  product surface and explained why Brewva added explicit workspace modes
- rollout-phase detail, edge-case matrices, and implementation sketches were
  removed after promotion
- the stable contract now lives in architecture/reference/journey docs and in
  the regression test suite rather than in `docs/research/`
