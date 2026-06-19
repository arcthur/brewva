# Decision: Context Operating System And Compaction Physics

## Metadata

- Decision: context-budget derivation, token-aware cut-point selection, workbench-gated compaction, and compaction economics are a governed runtime resource derived in substrate, observed through inspect, and kept authoritative through tape receipts.
- Date: `2026-06-18`
- Status: accepted
- Stable docs:
  - `docs/journeys/internal/context-and-compaction.md`
  - `docs/reference/runtime.md`
  - `docs/reference/tools.md`
  - `docs/architecture/system-architecture.md`
  - `docs/architecture/control-and-data-flow.md`
- Code anchors:
  - `packages/brewva-substrate/src/context-budget/api.ts`
  - `packages/brewva-substrate/src/compaction/session-cut-point.ts`
  - `packages/brewva-gateway/src/hosted/internal/context/evidence/context-evidence.ts`
  - `packages/brewva-cli/src/operator/inspect/cli.ts`

## Decision Summary

- Context-budget state derives through a substrate pure package, and runtime ops expose non-empty context status and compaction-gate state instead of optimistic constants.
- Cut-point selection is token-budget-aware with tail-protect and reserve tokens, and it cuts on turn boundaries rather than arbitrary offsets.
- Workbench-gated compaction is shared by manual, auto, and model-downshift callers; a mid-turn soft cut surfaces a `compaction_required` cause with a replayable compaction resume.
- Compaction input provenance and economic verdicts (`cache_regression`, `unaccounted_break`, `wasteful`) are inspectable context evidence, not replay authority.
- Replay authority stays on tape and stored compaction baselines, and the four runtime ports are not widened to carry context governance.
- The shared `decideCompaction(...)` policy and `context-budget/api.ts` originate in `context-control-plane-simplification`; this decision adds token-aware cut-point selection, compaction economics, and inspect surfaces on top.

## Axioms

This decision is judged against `docs/architecture/design-axioms.md`:

- Obeys axiom 1 (Attention belongs to the model): the runtime exposes physical context status and a compaction gate, but the model still decides what to compact through workbench tools.
- Obeys axiom 2 (Adaptive logic stays out of the kernel): cut-point selection and compaction economics live in substrate and evidence layers, never in the kernel commitment path.
- Obeys axiom 6 (Tape is commitment memory): `session_compact` receipts and stored baselines are replay authority, while economic verdicts remain evidence only.
- Obeys axiom 15 (Public width should compress toward authority width): context governance is derived in substrate and observed through inspect without widening the four runtime ports.

## Superseded by

- None.
