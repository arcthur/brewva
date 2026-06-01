# Decision: Prefix-Stable Context Management And Progressive Compaction

## Metadata

- Decision: hosted request construction separates stable prefix, deterministic dynamic tail, replay-visible compaction, and request-local reduction.
- Date: `2026-06-01`
- Status: accepted
- Stable docs:
  - `docs/reference/hosted-dynamic-context.md`
  - `docs/journeys/internal/context-and-compaction.md`
  - `docs/reference/configuration.md`
  - `docs/architecture/system-architecture.md`
  - `docs/reference/token-cache.md`
  - `docs/reference/budget-matrix.md`
- Code anchors:
  - `packages/brewva-gateway/src/hosted/internal/context/context-contract.ts`
  - `packages/brewva-gateway/src/hosted/internal/context/workbench-context.ts`
  - `packages/brewva-gateway/src/hosted/internal/provider/request/provider-request-reduction.ts`
  - `packages/brewva-gateway/src/hosted/internal/context/evidence/context-evidence.ts`
  - `script/report-context-evidence.ts`
  - `test/unit/gateway/provider-request-reduction-walker.unit.test.ts`

## Decision Summary

- Stable Brewva-owned prompt contract text stays outside live usage, context-window, and provider-window derived values.
- Scope-aware dynamic-tail rendering is deterministic at the producer boundary and is observed with prompt-stability evidence, not corrected by post-render string reuse.
- Transient outbound reduction rewrites only cloned provider-request payloads. It never mutates event tape, WAL, durable session history, replacement history, or compaction receipts.
- Recovery and output-budget retry paths keep full-fidelity request copies until reduction parity is proven for those postures.
- Prompt-stability, transient-reduction, and provider-cache observations live in context evidence and reports; they are not replay authority.

## Superseded by

- None.
