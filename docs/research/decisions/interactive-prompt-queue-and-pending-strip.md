# Decision: Interactive Prompt Queue And Pending Strip

## Metadata

- Decision: Interactive streaming now defaults to queue. The ordinary composer path submits a future turn when the current turn is still streaming; callers only specify `streamingBehavior` when they need a non-default low-level semantic such as explicit `followUp`.
- Date: `2026-04-27`
- Status: accepted
- Stable docs:
  - `docs/journeys/operator/interactive-session.md`
  - `docs/reference/session-lifecycle.md`
  - `docs/reference/commands.md`
  - `docs/guide/cli.md`
- Code anchors:
  - `packages/brewva-gateway/src/hosted/internal/session/managed-agent/runtime-session-controller.ts`
  - `packages/brewva-runtime/src/runtime/turn/impl.ts`
  - `packages/brewva-gateway/src/hosted/internal/session/managed-agent/session.ts`
  - `packages/brewva-substrate/src/session/prompt-session.ts`
  - `packages/brewva-substrate/src/session/session-host.ts`
  - `packages/brewva-cli/src/shell/domain/state.ts`
  - `packages/brewva-cli/src/shell/domain/state.ts`
  - `packages/brewva-cli/src/shell/controller/shell-runtime.ts`
  - `packages/brewva-cli/src/shell/domain/overlays/projectors/index.ts`

## Decision Summary

- Interactive streaming now defaults to queue. The ordinary composer path submits a future turn when the current turn is still streaming; callers only specify `streamingBehavior` when they need a non-default low-level semantic such as explicit `followUp`.
- Queue identity is authoritative and prompt-id based. Managed sessions expose queued prompt views carrying `promptId`, text, `submittedAt`, and `behavior`, and queued removal is id-based plus race-safe/idempotent.
- Queue UX is queue-only and operator-visible. The pending strip renders up to three `(pending)` rows, then `+N more · Ctrl+B to manage`; the queue overlay exposes detail inspection and deletion without aborting the active turn.
- `followUp` stays distinct. Explicit `followUp` callers remain explicit continuation flows and do not appear in the queue strip or queue overlay.
- Queue is not a slash-mode feature. The shell exposes queue management through keybinding/palette discovery rather than a dedicated `/queue` command.

## Superseded by

- None.
