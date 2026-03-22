# Research: Workflow Artifacts And Readiness Control Plane

## Document Metadata

- Status: `promoted`
- Owner: runtime maintainers
- Last reviewed: `2026-03-22`
- Promotion target:
  - `docs/architecture/system-architecture.md`
  - `docs/architecture/cognitive-product-architecture.md`
  - `docs/reference/runtime.md`
  - `docs/reference/events.md`
  - `docs/reference/skills.md`
  - `docs/reference/tools.md`
  - `docs/journeys/planning-to-execution.md`
  - `docs/journeys/background-and-parallelism.md`

## Promotion Summary

This note is now a short status pointer.

Workflow chaining has been promoted as a replay-first, advisory control-plane
surface built on top of existing runtime commitments rather than as a new
kernel-owned planner.

Stable implementation now includes:

- derived workflow artifacts from durable events such as `skill_completed`,
  verification events, subagent lifecycle events, and worker adoption outcomes
- readiness summaries for planning, implementation, review, verification, and
  release
- default `[WorkflowAdvisory]` context injection for model-facing advisory
  visibility
- `workflow_status` as an explicit operator/model inspection tool
- working projection entries such as `workflow.design`,
  `workflow.execution_plan`, `workflow.review`, and `workflow.verification`
- replay and restart rebuild coverage for workflow artifacts and readiness

Stable references:

- `docs/architecture/system-architecture.md`
- `docs/architecture/cognitive-product-architecture.md`
- `docs/reference/runtime.md`
- `docs/reference/events.md`
- `docs/reference/skills.md`
- `docs/reference/tools.md`
- `docs/journeys/planning-to-execution.md`
- `docs/journeys/background-and-parallelism.md`

## Stable Contract Summary

The promoted contract is:

1. Workflow artifacts are derived working-state projections, not new
   commitment-memory event families.
2. Readiness is advisory, not prescriptive.
3. The model may ignore a suggested next step and choose another valid path
   unless an independent governance or safety boundary blocks it.
4. Brewva does not introduce a kernel-owned workflow DAG or expand the public
   proposal boundary for workflow policy.

## Validation Status

Promotion is backed by:

- workflow derivation unit coverage
- projection rebuild unit coverage
- runtime restart/replay contract coverage
- system coverage that rebuilds workflow state from tape when projection state
  is missing

## Remaining Backlog

The following ideas are intentionally not part of the promoted contract:

- richer review-policy classification such as `AUTO-FIX` vs `ASK`
- specialist delegation/product roles layered on top of the workflow surfaces

If those areas become product priorities, they should start from a new focused
RFC rather than reopening this one as a mixed design-and-status document.

## Archive Notes

- Historical design-option analysis and phased rollout details were removed from
  this file after promotion.
- The stable contract lives in architecture, reference, journey docs, and
  regression tests rather than in `docs/research/`.
