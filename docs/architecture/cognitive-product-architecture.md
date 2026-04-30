# Cognitive Product Architecture

This page is a product-facing companion. It describes how Brewva presents
model, operator, and kernel boundaries without redefining authority. If wording
here conflicts with axioms, invariants, system architecture, or reference docs,
the narrower contract wins.

## Product Boundary

`Model sees narrative. Operator sees telemetry. Kernel sees receipts.`

- The model receives context, skill contracts, task framing, tool affordances,
  and recovery hints.
- The operator sees approvals, questions, task state, inspect views, session
  posture, cost, and diagnostics.
- The kernel records decisions, effects, verification, rollback, recovery, and
  replay truth.

## Context Product

Context composition is a product layer over runtime facts. It may combine
stable contracts, active task state, working projection, recall, skill
contracts, and advisory memory, but it must preserve provenance and conflict
posture.

## Operator Product

The CLI/TUI shell is an experience ring surface. It owns overlays, keybindings,
transcript rendering, model selection, provider connection flows, inbox,
approvals, and drill-down views. These surfaces render runtime truth; they do
not create it.

## Kernel Product

The kernel product is intentionally boring: effect gates, receipts, replay,
verification, rollback, Recovery WAL, and durable event families. If a feature
needs durable authority, it should enter through `runtime.authority` rather
than through model-facing prompt shape.

## Explicit Non-Goals

- no prompt-only authority
- no hidden runtime planner inferred from product lanes
- no model-writable durable control state
- no UI presentation object that changes replay truth

## Related Docs

- `docs/architecture/system-architecture.md`
- `docs/reference/context-composer.md`
- `docs/reference/runtime.md`
- `docs/reference/commands/interactive.md`
