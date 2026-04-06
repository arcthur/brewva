# Research: Context Budget Behavior In Long-Running Sessions

## Document Metadata

- Status: `active`
- Owner: runtime maintainers
- Last reviewed: `2026-04-06`
- Promotion target:
  - `docs/journeys/internal/context-and-compaction.md`
  - `docs/reference/configuration.md`
  - `docs/reference/limitations.md`

## Problem Statement And Scope Boundaries

Projection injection must stay bounded and deterministic as session history
grows.

This note covers:

- context-budget behavior under large histories
- deterministic projection shaping and compaction boundaries
- operator-visible limits and failure modes

This note does not reopen:

- unrelated changes to working projection semantics
- widening internal-only budget knobs into public configuration by default

## Working Hypotheses

- Stable docs should distinguish configurable budget controls from internal
  runtime heuristics.
- Long-history behavior should be described as deterministic shaping rules, not
  as best-effort implementation detail.
- Operator-facing limitations belong in reference and troubleshooting docs, not
  only in code or tests.

## Source Anchors

- Context transform hook: `packages/brewva-gateway/src/runtime-plugins/context-transform.ts`
- Runtime context budget service: `packages/brewva-runtime/src/context/budget.ts`
- Runtime context API wiring: `packages/brewva-runtime/src/runtime.ts`

## Validation Signals

- Context budget behavior remains covered in
  `test/contract/runtime/context-budget.contract.test.ts`
- Context injection behavior remains covered in
  `test/contract/runtime/context-injection.contract.test.ts`

## Promotion Criteria

- Configurable versus internal budget knobs are explicit in reference docs.
- Long-session failure modes and mitigation guidance are documented.
- Internal journey docs explain compaction and projection shaping coherently.
