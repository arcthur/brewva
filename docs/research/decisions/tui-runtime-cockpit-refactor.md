# Decision: TUI Runtime Cockpit Refactor

## Metadata

- Decision: The interactive TUI default is a runtime cockpit, not a transcript-first chat surface. The cockpit projects runtime physics, current work, decisions, effect receipts, attention posture, recovery state, composer policy, and bounded archive refs from replay-visible evidence.
- Date: `2026-05-28`
- Status: accepted
- Stable docs:
  - `docs/reference/commands/interactive.md`
  - `docs/architecture/cognitive-product-architecture.md`
  - `docs/reference/working-projection.md`
  - `docs/reference/events/README.md`
  - `docs/reference/glossary.md`
- Code anchors:
  - `packages/brewva-cli/src/shell/domain/cockpit/`
  - `packages/brewva-cli/src/shell/controller/cockpit-sync.ts`
  - `packages/brewva-cli/runtime/shell/cockpit/surface.tsx`
  - `packages/brewva-cli/src/shell/domain/overlays/projectors/cockpit-archive.ts`
  - `packages/brewva-cli/runtime/shell/overlays/data-overlays.tsx`
  - `packages/brewva-cli/src/shell/domain/session-phase.ts`
  - `packages/brewva-tools/src/contracts/runtime.ts`

## Decision Summary

- Transcript-first default UI is removed for the interactive shell. Transcript, raw event tape, tool output, and receipt detail remain explicit-pull archive or pager surfaces.
- `ShellCockpitProjection` is the renderer-facing read model. It is deterministic from `SessionPhase`, Work Card, context cockpit, operator snapshot, session wire, runtime events, cost posture, rewind targets, channels, transitions, and observation cursor.
- Decision lane owns active operator choices. Approval, question, cost gate, adoption, recovery confirmation, and manual gate items are discriminated projection variants with bounded actions and evidence refs.
- Effect ledger renders consequence, verdict, action class, duration, rollback ref, archive refs, and freshness before raw output. Observation receipts collapse unless failed, selected, or needed for an active decision.
- Attention and archive surfaces are explicit-pull overlays. Opening them does not mutate workbench, recall, compaction, provider routing, capability selection, or model-visible context.
- Composer behavior follows phase policy: active, muted, stash, queue, or block. Blocked/muted/stashed phases reject renderer mutation paths before they alter prompt state.
- The accepted surface supports full, narrow, and mini terminal modes while preserving a stable cockpit-first contract and responsive archive/detail drill-down.

## Superseded by

- None.
