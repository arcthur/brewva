# Context And Compaction Journey

This journey describes the single-path context governance loop.

## Goal

Guarantee bounded context behavior with explicit stop/compact semantics:

- one deterministic injection path
- hard budget boundary
- explicit compaction gate before tool execution under critical pressure

## Runtime Flow

1. `before_agent_start`
   - runtime collects deterministic context sources
   - sources are registered in `ContextArena`
   - injection plan is built and budgeted once
2. Pressure evaluation
   - `ContextPressureService` evaluates usage ratio and gate status
   - if `critical` without recent compaction, gate is armed
3. Tool execution boundary
   - non-control-plane tools are blocked while gate is armed
   - `session_compact` (and lifecycle control tools) can pass
4. Compaction completion
   - `markContextCompacted(...)` clears scope fingerprints/reserved tokens
   - emits integrity and governance events for audit

## Source Set

Default governance sources:

- `brewva.identity`
- `brewva.context-packets`
- `brewva.runtime-status`
- `brewva.task-state`
- `brewva.projection-working`

## SLO And Degradation

- Arena has entry ceiling: `infrastructure.contextBudget.arena.maxEntriesPerSession`
- when ceiling is reached, runtime enforces hard boundary (rejects new append)
- `context_arena_slo_enforced` is emitted for audit

No source-classifier downgrade path is used.
