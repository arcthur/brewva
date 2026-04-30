# Decision: Workflow Artifacts And Posture Control Plane

## Metadata

- Decision: Workflow artifacts are derived working-state projections, not new commitment-memory event families.
- Date: `2026-03-23`
- Status: accepted
- Stable docs:
  - `docs/architecture/system-architecture.md`
  - `docs/architecture/cognitive-product-architecture.md`
  - `docs/reference/runtime.md`
  - `docs/reference/events/README.md`
  - `docs/reference/skills.md`
  - `docs/reference/tools.md`
  - `docs/journeys/operator/interactive-session.md`
  - `docs/journeys/operator/background-and-parallelism.md`
- Code anchors:
  - `N/A`

## Decision Summary

- Workflow artifacts are derived working-state projections, not new commitment-memory event families.
- Posture is advisory, not prescriptive.
- Workflow inspection is explicit pull rather than default push in the hosted path.
- The model may choose another valid path unless an independent governance or safety boundary blocks it.
- Brewva does not introduce a kernel-owned workflow DAG or expand the public proposal boundary for workflow policy.

## Superseded by

- None.
