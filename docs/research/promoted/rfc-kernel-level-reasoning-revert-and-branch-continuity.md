# Research: Kernel-Level Reasoning Revert And Branch Continuity

## Document Metadata

- Status: `promoted`
- Owner: runtime and gateway maintainers
- Last reviewed: `2026-04-06`
- Promotion target:
  - `docs/architecture/system-architecture.md`
  - `docs/architecture/exploration-and-effect-governance.md`
  - `docs/reference/events.md`
  - `docs/reference/runtime.md`
  - `docs/reference/runtime-plugins.md`
  - `docs/reference/session-lifecycle.md`
  - `docs/journeys/internal/context-and-compaction.md`

## Promotion Summary

This note is now a promoted status pointer.

The accepted decision is:

- Brewva keeps reasoning revert as a kernel-owned, append-only branch
  continuity commitment rather than a filesystem undo feature or a hosted-only
  history rewrite shortcut.
- The key idea learned from DenwaRenji / `kimi-cli` was preserved:
  revert should target an explicit checkpoint and carry one bounded continuity
  note onto the resumed path.
- The mutable context-file implementation used by `kimi-cli` was not copied.
  Brewva translates the idea into durable receipts, replay-derived active
  lineage, and WAL-backed hosted resume.

Stable implementation now includes:

- durable `reasoning_checkpoint` and `reasoning_revert` receipts on tape
- a separate reasoning replay fold that derives active lineage from durable
  branch receipts
- hosted recovery through `session_turn_transition(reason=reasoning_revert_resume)`
  plus rebuilt active-branch messages
- narrow automatic checkpointing at `turn_start`,
  `verification_boundary`, and `compaction_boundary`
- bounded continuity admission with schema normalization and a hard byte cap
- explicit separation between reasoning revert and receipt-based filesystem
  rollback

Stable references:

- `docs/architecture/system-architecture.md`
- `docs/architecture/exploration-and-effect-governance.md`
- `docs/reference/events.md`
- `docs/reference/runtime.md`
- `docs/reference/runtime-plugins.md`
- `docs/reference/session-lifecycle.md`
- `docs/journeys/internal/context-and-compaction.md`

## Stable Contract Summary

The promoted contract is:

1. Tape holds branch truth.
   `reasoning_checkpoint` and `reasoning_revert` are durable source-of-truth
   receipts for reasoning-branch continuity. Recovery WAL does not own the
   active branch.
2. Replay derives the active lineage.
   Active reasoning state is reconstructed from append-only branch receipts in a
   separate replay fold. Off-lineage or malformed revert targets are ignored
   during replay rather than trusted because they once passed write-time
   validation.
3. Reasoning revert is not world rollback.
   Reverting a reasoning branch does not roll back files, reset approvals,
   erase evidence truth, or reset cost truth. Optional linkage to receipt-based
   mutation rollback remains explicit through `linkedRollbackReceiptIds`.
4. Hosted resume is bounded and replay-first.
   Hosted recovery may rebuild model-visible messages from the surviving branch
   and continue with `reasoning_revert_resume`, but it does not create a second
   hidden prompt path or a separate branch-truth authority surface.
5. Public reasoning revert provenance is explicit.
   Public tool calls that omit `trigger` normalize to `operator_request`;
   `model_self_repair` must be explicit in the durable receipt.
6. Continuity is durable but tightly bounded.
   Continuity packets normalize to `brewva.reasoning.continuity.v1` and are
   rejected when the UTF-8 payload exceeds the hard `1200` byte ceiling.

## Validation Status

Promotion is backed by:

- runtime authority and inspection surfaces for reasoning checkpoints, reverts,
  replay state, and lineage-aware revert eligibility
- replay coverage for valid branch progression, nested revert behavior,
  superseded-tail rejection, and malformed/off-lineage event rejection
- gateway recovery coverage showing that pending reasoning revert resume is
  replayed through the existing prompt WAL and serialized turn-owner path
- hosted event-stream coverage for narrow automatic checkpoint policy and
  verification-boundary checkpoint behavior
- operator/tooling coverage showing active lineage and recent revert state
  through the inspection and tape-info surfaces
- repository verification via `bun run check`, `bun test`,
  `bun run test:docs`, and `bun run format:docs:check`

## Source Anchors

- `packages/brewva-runtime/src/contracts/reasoning.ts`
- `packages/brewva-runtime/src/tape/reasoning-events.ts`
- `packages/brewva-runtime/src/tape/reasoning-replay.ts`
- `packages/brewva-runtime/src/services/reasoning.ts`
- `packages/brewva-runtime/src/events/event-types.ts`
- `packages/brewva-tools/src/reasoning-checkpoint.ts`
- `packages/brewva-tools/src/reasoning-revert.ts`
- `packages/brewva-tools/src/tape.ts`
- `packages/brewva-gateway/src/runtime-plugins/event-stream.ts`
- `packages/brewva-gateway/src/session/reasoning-revert-recovery.ts`
- `packages/brewva-gateway/src/session/worker-main.ts`
- `packages/brewva-gateway/src/session/turn-transition.ts`

## Remaining Backlog

The following areas remain intentionally outside the promoted core:

- frontend or operator-native visualization of reasoning branches and recent
  revert history beyond current inspection products
- more proactive policy that converts verification or hosted failure patterns
  into automatic revert decisions
- any future extension that would add dedicated frontend frames for branch
  visualization instead of relying on the existing session-transition and
  inspection surfaces

If those areas become priorities, they should start from a new focused RFC
rather than reopening this promoted status pointer as a mixed design-and-rollout
document.

## Historical Notes

- historical design exploration, DenwaRenji comparison detail, replay
  algorithm sketches, rollout phases, and implementation-time edge-case notes
  were removed from this file after promotion
- the stable contract now lives in architecture/reference/journey docs and in
  the regression test suite rather than in `docs/research/`
