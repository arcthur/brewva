# Decision: Model-Operated Working Memory And Context Governance Reset

## Metadata

- Decision: Brewva context governance is model-operated. The model owns attention through the workbench and on-demand recall; the kernel owns consequence; the tape owns truth; the runtime owns physical constraints such as context windows, cache, cost, recovery, and provider behavior.
- Date: `2026-05-08`
- Status: accepted
- Stable docs:
  - `docs/architecture/design-axioms.md`
  - `docs/architecture/system-architecture.md`
  - `docs/architecture/cognitive-product-architecture.md`
  - `docs/reference/hosted-dynamic-context.md`
  - `docs/reference/extensions.md`
  - `docs/reference/token-cache.md`
  - `docs/reference/tools/memory-and-recall.md`
  - `docs/journeys/internal/context-and-compaction.md`
- Code anchors:
  - `packages/brewva-runtime/src/model/workbench/service.ts`
  - `packages/brewva-runtime/src/internal/legacy-runtime/model/context/context-pressure.ts`
  - `packages/brewva-runtime/src/internal/legacy-runtime/model/context/context-compaction-gate.ts`
  - `packages/brewva-runtime/src/internal/legacy-runtime/model/context/history-view-baseline.ts`
  - `packages/brewva-gateway/src/hosted/internal/compaction/summary-generator.ts`
  - `packages/brewva-gateway/src/hosted/internal/context/hosted-workbench-context-pipeline.ts`
  - `packages/brewva-gateway/src/hosted/internal/provider/request/provider-request-reduction.ts`
  - `packages/brewva-tools/src/families/memory/workbench.ts`
  - `packages/brewva-tools/src/families/memory/recall.ts`
  - `<deleted: packages/brewva-runtime/src/internal/legacy-runtime/model/context/provider.ts>`
  - `<deleted: packages/brewva-runtime/src/internal/legacy-runtime/model/context/injection-orchestrator.ts>`
  - `<deleted: packages/brewva-recall/src/context/provider.ts>`

## Decision Summary

- The constitutional line is `Model owns attention. Kernel owns consequence. Tape owns truth. Runtime owns physics.`
- Runtime-owned context injection, hidden recall admission, skill-load gates, deterministic primary compaction, typed deliberation artifacts, and pressure-service ownership are not the default cognitive path.
- The model-facing memory surface is the workbench: note, evict, undo eviction before baseline, and compact. Workbench entries are inspectable and non-authoritative; compaction baseline commits close reversibility.
- Recall is an on-demand model tool. Source typing, provenance, and ranking remain useful substrate data, but no recall provider silently admits memory into every turn.
- Primary hosted compaction is LLM-driven through the gateway model-call boundary. Deterministic compaction exists only as an explicitly marked emergency fallback.
- Dynamic context rendering is narrow and cache-aware. Request-local reduction is a cache-class provider-request rewrite, not replay-visible history mutation.
- History-view baselines come from durable compaction receipts and sanitized summary digests. Advisory memory may inform compaction inputs but never becomes replay truth.
- The remaining active work is empirical validation: long-session cache behavior, compaction drift, on-demand recall quality, and operator evidence for degraded recovery.

## Superseded by

- `docs/research/decisions/four-port-runtime-simplification-rfc.md`
