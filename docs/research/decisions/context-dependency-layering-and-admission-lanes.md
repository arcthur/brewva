# Decision: Context Dependency Layering And Admission Lanes

## Metadata

- Decision: Context governance uses three non-interchangeable objects. Primary registry sources are source-typed runtime providers. Guarded supplemental families are post-primary, headroom-governed exception-lane blocks. Composer policy blocks are provenance-tagged render artifacts.
- Date: `2026-04-21`
- Status: accepted
- Stable docs:
  - `docs/architecture/system-architecture.md`
  - `docs/reference/hosted-dynamic-context.md`
  - `docs/reference/runtime.md`
  - `docs/reference/extensions.md`
  - `docs/journeys/internal/context-and-compaction.md`
- Code anchors:
  - `<deleted: packages/brewva-runtime/src/domain/context/provider.ts>`
  - `packages/brewva-runtime/src/domain/context/builtins.ts`
  - `packages/brewva-runtime/src/domain/context/dependency-views.ts`
  - `<deleted: packages/brewva-runtime/src/domain/context/arena.ts>`
  - `<deleted: packages/brewva-runtime/src/domain/context/injection.ts>`
  - `packages/brewva-runtime/src/runtime/runtime.ts`
  - `packages/brewva-runtime/src/domain/context/context.ts`
  - `packages/brewva-gateway/src/hosted/internal/context/hosted-workbench-context-pipeline.ts`

## Decision Summary

- Context governance uses three non-interchangeable objects. Primary registry sources are source-typed runtime providers. Guarded supplemental families are post-primary, headroom-governed exception-lane blocks. Composer policy blocks are provenance-tagged render artifacts.
- Primary provider descriptors are the metadata truth. Source selection, inspect tooling, and contract tests should derive from the provider descriptor surface rather than from duplicated static tables or hand-maintained source lists.
- Historical note: the named hosted profile field described in the original decision was removed. Current hosted context materialization has no passive `minimal` / `standard` / `full` `contextProfile` knob; the gateway-owned materialization module derives the model context and validated effect command plan directly from hosted session state.
- Repo-owned built-ins consume named runtime views or read-model helpers. The kernel remains the upstream integration boundary, but broad kernel access is no longer the default dependency shape for primary context providers.
- Exception lanes stay explicit. Continuity-bearing source material does not silently migrate into `guarded_supplemental`, and composer policy blocks do not widen into a second pseudo-source taxonomy.

## Superseded by

- `docs/research/decisions/model-operated-working-memory-and-context-governance-reset.md`
- `docs/research/decisions/hosted-context-materialization-ownership.md`
