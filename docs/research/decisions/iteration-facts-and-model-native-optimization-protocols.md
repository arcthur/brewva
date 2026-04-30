# Decision: Iteration Facts And Model-Native Optimization Protocols

## Metadata

- Decision: Brewva is substrate, not optimizer.
- Date: `2026-03-22`
- Status: accepted
- Stable docs:
  - `docs/architecture/design-axioms.md`
  - `docs/architecture/cognitive-product-architecture.md`
  - `docs/architecture/system-architecture.md`
  - `docs/reference/runtime.md`
  - `docs/reference/events/README.md`
  - `docs/reference/skills.md`
  - `docs/reference/tools.md`
  - `docs/journeys/operator/intent-driven-scheduling.md`
- Code anchors:
  - `N/A`

## Decision Summary

- Brewva is substrate, not optimizer.
- Runtime may persist only objective iteration evidence: metric observations and guard results on the default model-writable surface.
- Loop strategy remains model-native and may not be hardened into a runtime-owned planner.
- Workflow/projection surfaces may summarize iteration facts, but those summaries remain advisory rather than authoritative.
- Scheduling and watchdog flows may reference iteration facts, but kernel authority remains on effects, receipts, replay, rollback, and verification evidence.

## Superseded by

- None.
