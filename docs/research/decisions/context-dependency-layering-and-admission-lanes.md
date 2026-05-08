# Decision: Context Dependency Layering And Admission Lanes

## Metadata

- Decision: Context governance uses three non-interchangeable objects. Primary registry sources are source-typed runtime providers. Guarded supplemental families are post-primary, headroom-governed exception-lane blocks. Composer policy blocks are provenance-tagged render artifacts.
- Date: `2026-04-21`
- Status: accepted
- Stable docs:
  - `docs/architecture/system-architecture.md`
  - `docs/reference/hosted-dynamic-context.md`
  - `docs/reference/runtime.md`
  - `docs/reference/runtime-plugins.md`
  - `docs/journeys/internal/context-and-compaction.md`
- Code anchors:
  - `<deleted: packages/brewva-runtime/src/domain/context/provider.ts>`
  - `packages/brewva-runtime/src/domain/context/builtins.ts`
  - `packages/brewva-runtime/src/domain/context/dependency-views.ts`
  - `<deleted: packages/brewva-runtime/src/domain/context/arena.ts>`
  - `<deleted: packages/brewva-runtime/src/domain/context/injection.ts>`
  - `packages/brewva-runtime/src/runtime/runtime.ts`
  - `packages/brewva-runtime/src/domain/context/context.ts`
  - `packages/brewva-gateway/src/runtime-plugins/hosted-workbench-context-pipeline.ts`

## Decision Summary

- Context governance uses three non-interchangeable objects. Primary registry sources are source-typed runtime providers. Guarded supplemental families are post-primary, headroom-governed exception-lane blocks. Composer policy blocks are provenance-tagged render artifacts.
- Primary provider descriptors are the metadata truth. Source selection, inspect tooling, and contract tests should derive from the provider descriptor surface rather than from duplicated static tables or hand-maintained source lists.
- Hosted profiles are named selection policies over provider descriptors. `minimal` means `profileSelectable && continuityCritical`. `standard` means `profileSelectable && plane in {history_view, working_state}`. `full` installs no narrowing. These are explicit product policies compiled from the provider contract, not a second registry and not an unrestricted automatic projection layer.
- Repo-owned built-ins consume named runtime views or read-model helpers. The kernel remains the upstream integration boundary, but broad kernel access is no longer the default dependency shape for primary context providers.
- Exception lanes stay explicit. Continuity-bearing source material does not silently migrate into `guarded_supplemental`, and composer policy blocks do not widen into a second pseudo-source taxonomy.

## Superseded by

- `docs/research/decisions/model-operated-working-memory-and-context-governance-reset.md`
