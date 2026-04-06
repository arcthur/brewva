# Research: Cost Observability And Budget Governance

## Document Metadata

- Status: `active`
- Owner: runtime maintainers
- Last reviewed: `2026-04-06`
- Promotion target:
  - `docs/reference/runtime.md`
  - `docs/reference/configuration.md`
  - `docs/reference/budget-matrix.md`
  - `docs/journeys/operator/inspect-replay-and-recovery.md`

## Problem Statement And Scope Boundaries

Cost accounting and budget alerts should stay transparent enough for operators
to diagnose spend and policy behavior without reading runtime internals.

This note covers:

- runtime cost accounting surfaces
- budget alert semantics and operator expectations
- session bootstrap and reporting flow for cost visibility

This note does not reopen:

- provider-specific pricing policy outside documented cost reporting behavior
- unrelated scheduling or planning policies

## Working Hypotheses

- Budget policy and alert semantics should be explicit in stable reference docs.
- Operators need a consistent diagnosis path that ties runtime surfaces,
  configuration, and session reporting together.
- Cost observability should remain inspectable without widening authority or
  introducing hidden control-plane state.

## Source Anchors

- Cost tracker: `packages/brewva-runtime/src/cost/tracker.ts`
- Runtime cost surface wiring: `packages/brewva-runtime/src/runtime.ts`
- Session bootstrap and reporting path:
  `packages/brewva-gateway/src/host/create-hosted-session.ts`

## Validation Signals

- Cost tracking behavior remains covered in
  `test/live/provider/cost-tracking.live.test.ts`
- Runtime cost API docs stay aligned with runtime surface tests.

## Promotion Criteria

- Budget policy and alert semantics are explicit in reference docs.
- Budget-matrix and runtime docs describe cost visibility without ambiguity.
- Operator docs describe a stable diagnosis path for unexpected spend.
