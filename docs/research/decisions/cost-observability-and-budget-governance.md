# Decision: Cost Observability And Budget Governance

## Metadata

- Decision: cost and budget behavior are inspectable replay-derived runtime surfaces, not hidden hosted control-plane state.
- Date: `2026-06-01`
- Status: accepted
- Stable docs:
  - `docs/reference/runtime.md`
  - `docs/reference/configuration.md`
  - `docs/reference/budget-matrix.md`
  - `docs/reference/tools.md`
  - `docs/journeys/operator/inspect-replay-and-recovery.md`
- Code anchors:
  - `packages/brewva-runtime/src/runtime/tape/impl.ts`
  - `packages/brewva-runtime/src/runtime/runtime.ts`
  - `packages/brewva-tools/src/families/workflow/cost-view.ts`
  - `packages/brewva-tools/src/families/workflow/observability/obs-snapshot.ts`
  - `packages/brewva-cli/src/operator/inspect/report.ts`
  - `test/live/provider/cost-tracking.live.test.ts`

## Decision Summary

- Session cost is folded from runtime usage and cost events; operators inspect it through runtime projections, `cost_view`, observability snapshots, and inspect reports.
- Budget blocking and alert semantics follow `infrastructure.costTracking.*` and documented budget-matrix behavior instead of provider-specific hidden state.
- Cache-read tokens remain visible in cost summaries but are excluded from tracked token totals where the budget contract says so.
- Cost visibility does not widen tool authority, provider routing, context admission, or scheduling policy.

## Superseded by

- None.
