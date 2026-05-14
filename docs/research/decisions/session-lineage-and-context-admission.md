# Decision: Session Lineage And Context Admission

## Metadata

- Decision: Session lineage models work-branch topology, and context-entry records model transcript admission.
- Date: `2026-05-05`
- Status: accepted
- Stable docs:
  - `docs/architecture/system-architecture.md`
  - `docs/architecture/control-and-data-flow.md`
  - `docs/architecture/invariants-and-reliability.md`
  - `docs/reference/runtime.md`
  - `docs/reference/events/README.md`
  - `docs/reference/events/session.md`
  - `docs/reference/session-lifecycle.md`
  - `docs/reference/hosted-dynamic-context.md`
  - `docs/reference/artifacts-and-paths.md`
  - `docs/reference/tools/delegation.md`
- Code anchors:
  - `packages/brewva-runtime/src/domain/sessions/lineage.ts`
  - `packages/brewva-runtime/src/domain/sessions/lineage-event-descriptors.ts`
  - `packages/brewva-runtime/src/domain/context/builtins.ts`
  - `packages/brewva-gateway/src/hosted/internal/session/projection/runtime-projection-session-store.ts`
  - `packages/brewva-gateway/src/delegation/lineage.ts`
  - `packages/brewva-session-index/src/factory.ts`
  - `packages/brewva-cli/src/shell/overlays/lifecycle.ts`
  - `packages/brewva-cli/src/shell/ports/session-adapter.ts`
  - `test/contract/runtime/session-lineage.contract.test.ts`

## Decision Summary

- Event tape remains the replay authority. Session lineage is a rebuildable session-domain read model under root authority and root inspection session surfaces, not a new runtime root.
- Hosted sessions must start with an explicit `session_root` lineage node. Hosted lineage paths do not synthesize compatibility roots for old tapes without that root.
- Model-facing ancestry and visibility live on `brewva.context.entry.recorded.v1` linker events. Existing source message, compaction, summary, and tool-result events keep their own shapes.
- Child outcomes default to state-only. Parent-visible model context requires explicit `brewva.session.lineage.outcome_adopted.v1` adoption, and sibling raw transcript is never injected through the lineage provider.
- There is no session-global active leaf. Channel-local selection is advisory UX state, and CLI/TUI checkout resolves an explicit leaf entry before changing the visible transcript.
- Capability state is state-only, fail-closed against declared capability owners, and bounded so larger state must use artifact references.

## Superseded by

- None.
