# Decision: Hosted Materialization Plan

## Metadata

- Decision: Hosted context composition owns direct lifecycle side effects without a plan/commit DAG.
- Date: `2026-05-13`
- Status: accepted
- Stable docs:
  - `docs/reference/extensions.md`
  - `docs/architecture/control-and-data-flow.md`
  - `docs/architecture/system-architecture.md`
- Code anchors:
  - `packages/brewva-gateway/src/hosted/internal/context/materialization.ts`
  - `packages/brewva-gateway/src/hosted/internal/context/workbench-context.ts`

## Decision Summary

- Hosted lifecycle call sites invoke the context owner directly for usage
  observation, telemetry, context composition, prompt evidence, provider-cache
  evidence, visible-read state, and delegation surfacing.
- There is no hosted context materialization plan/commit DAG or command-order
  validator.
- Observer return values are step-local data and are not persisted as plans.
- Full effect payloads stay inside gateway hosted owner modules.
- Extension-facing materialization views remain redacted and read-only.

## Superseded by

- Context chain subtraction and evidence-state collapse.
