# Decision: Session Tree Navigation

## Metadata

- Decision: `/tree` is the context-entry micro-navigation overlay, and `/lineage` remains the work-branch macro-topology overlay.
- Date: `2026-06-01`
- Status: accepted
- Stable docs:
  - `docs/guide/cli.md`
  - `docs/reference/commands/interactive.md`
  - `docs/reference/events/session.md`
  - `docs/reference/session-lifecycle.md`
- Code anchors:
  - `packages/brewva-cli/src/shell/commands/shell-command-registry.ts`
  - `packages/brewva-cli/src/shell/domain/overlays/projectors/tree.ts`
  - `packages/brewva-cli/src/shell/overlays/lifecycle.ts`
  - `packages/brewva-cli/src/shell/ports/session-adapter.ts`
  - `packages/brewva-cli/src/shell/ports/session-port.ts`
  - `packages/brewva-substrate/src/session/managed-session-store.ts`
  - `test/unit/cli/overlay-projectors.unit.test.ts`
  - `test/unit/cli/shell-runtime-session-lifecycle.unit.test.ts`
  - `test/unit/substrate/managed-session-store.unit.test.ts`

## Decision Summary

- Brewva exposes `/tree` as a CLI context-entry tree for exact transcript navigation, prompt restoration, branch carry summaries, and explicit rewind escalation.
- `/tree` derives its projection from replayable session state: context-entry records, lineage records, branch summaries, and rewind checkpoints. It does not add a runtime root, session-index truth source, hidden context admission path, or second memory store.
- Conversation-only checkout is the default. Workspace rollback remains explicit and is delegated to the existing rewind service, including checkpoint flooring when a selected context entry has no exact rewind checkpoint.
- Branch carry summaries are durable branch-summary events with bounded active materialization. Raw abandoned tool results are not cherry-picked into the new branch.
- Prompt restoration restores literal user text only. Mentions and slash text are re-resolved on submit against the current workspace; non-lossless payloads are omitted with an advisory.
- `/lineage` remains required for macro topology, including work branches, recovery branches, delegation outcomes, adoption, and channel-local selection. `/tree` and `/lineage` cross-focus while keeping the active leaf as the shared source of transcript truth.

## Superseded by

- None
