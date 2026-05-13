# Decision: Hosted Materialization Plan

## Metadata

- Decision: Hosted context composition plans materialization as validated command data before executing side effects.
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

- `planHostedContextMaterialization(...)` returns `{ modelContext, effects, audit }`.
- `HostedContextEffectCommand` is the single type source for the effect union; the committed order and effect-to-command map are generated from one typed command metadata tuple.
- `commitHostedContextMaterialization(...)` validates order, duplicates, and supported effect commands before interpreting the plan.
- Observer return values are step-local commit data and are not written into plans.
- Full effect command payloads stay inside gateway hosted owner modules.
- Extension-facing materialization views remain redacted and read-only.

## Superseded by

- None.
