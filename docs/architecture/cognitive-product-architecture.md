# Cognitive Product Architecture

This page is a product-facing companion. It describes how Brewva presents the
model, operator, kernel, and runtime physics boundaries without redefining
authority. If wording here conflicts with axioms, invariants, system
architecture, or reference docs, the narrower contract wins.

## Product Boundary

`Model sees workbench. Operator sees telemetry. Kernel sees receipts.`

- The model sees stable instructions, active workbench entries, model-requested
  recall results, tool affordances, and small physical-status nudges.
- The operator sees approvals, questions, task state, inspect views, memory
  operations, session posture, cache, cost, and diagnostics.
- The kernel records decisions, effects, verification, rollback, recovery, and
  replay truth.
- Runtime physics exposes limits and failure posture: context window, cache,
  cost, provider behavior, durability, and recovery constraints.

## Workbench Product

The primary cognitive product is the workbench, not context injection.

The workbench is a model-authored notebook made of free-form notes and
evictions with source references, reasons, digests, and preserved quotes. The
model decides what deserves future attention. Brewva records that decision for
inspection and recovery without treating it as effect authority.

The workbench should remain deliberately small:

- `workbench_note` writes a memory entry.
- `workbench_evict` removes stale spans from active attention and may preserve
  replacement notes or exact quotes.
- `recall_search` is called on demand when the model needs previous evidence.
- `workbench_compact` creates a compact baseline when the model or hard context
  limit requires it.

No runtime service should rebuild a hidden thought path by preselecting skills,
recall entries, task stages, or finish posture before the model asks.

## Context Product

Context composition is request materialization over runtime facts. Its default
shape is:

1. stable contracts and tool schemas
2. active workbench entries
3. explicitly requested details such as recall results or capability details
4. numeric context status and other small dynamic-tail facts

Context composition preserves provenance, cache posture, and hard-limit
instructions. It is not the product layer that decides salience.

## Operator Product

The CLI/TUI shell is an experience ring surface. It owns overlays, keybindings,
transcript rendering, model selection, provider connection flows, inbox,
approvals, memory-operation visibility, cache/cost summaries, and drill-down
views. These surfaces render runtime claims and workbench evidence; they do not
create authority.

## Kernel Product

The kernel product is intentionally boring: effect gates, receipts, replay,
verification, rollback, Recovery WAL, and durable event families. If a feature
needs durable authority, it should enter through `runtime.authority` rather
than through model-facing prompt shape.

## Explicit Non-Goals

- no prompt-only authority
- no hidden runtime planner inferred from product lanes
- no runtime-owned attention selector
- no model-writable durable control state
- no UI presentation object that changes replay truth

## Related Docs

- `docs/architecture/system-architecture.md`
- `docs/reference/hosted-dynamic-context.md`
- `docs/reference/runtime.md`
- `docs/reference/tools/memory-and-recall.md`
- `docs/reference/commands/interactive.md`
