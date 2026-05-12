# Decision: Capability Compression and Output Distillation

## Metadata

- Decision: Output-side tool result distillation is stable; definition-side capability compression remains deferred.
- Date: `2026-03-02`
- Status: accepted
- Stable docs:
  - `docs/reference/runtime.md`
  - `docs/reference/extensions.md`
  - `docs/reference/events/README.md`
  - `docs/reference/tools.md`
  - `docs/architecture/system-architecture.md`
- Code anchors:
  - `N/A`

## Decision Summary

- Output-side distillation is part of the stable runtime and presentation contract.
- Stable output-side behavior includes tool output artifact persistence, tool output distillation events, distilled-output context injection, output search over persisted artifacts, and gateway/CLI display summaries.
- Definition-side compression such as `capability_search` or `capability_execute` remains deferred until tool cardinality and routing quality justify the additional protocol and governance complexity.

## Superseded by

- `docs/research/decisions/model-operated-working-memory-and-context-governance-reset.md`
