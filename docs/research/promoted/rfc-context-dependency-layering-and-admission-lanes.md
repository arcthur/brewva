# Research: Context Dependency Layering And Admission Lanes

## Document Metadata

- Status: `promoted`
- Owner: runtime and gateway maintainers
- Last reviewed: `2026-04-18`
- Promotion target:
  - `docs/architecture/system-architecture.md`
  - `docs/reference/context-composer.md`
  - `docs/reference/runtime.md`
  - `docs/reference/runtime-plugins.md`
  - `docs/journeys/internal/context-and-compaction.md`

## Promotion Summary

This note is now a short status pointer.

The decision has been promoted: Brewva treats context governance as three
different object kinds with different contracts, and the primary provider
descriptor is the runtime-owned metadata truth for source admission.

Stable implementation now includes:

- explicit primary-source contract metadata for plane, lane, scheduling,
  dependency reads, continuity posture, profile posture, and preservation policy
- `collectionOrder` and `selectionPriority` as separate concerns rather than one
  overloaded `order`
- repo-owned built-ins reading through named dependency views or read-model
  helpers instead of reaching broadly into kernel state by default
- explicit guarded-supplemental family identity and lane rationale
- composer policy blocks carrying render provenance rather than being forced
  into source contracts
- `context_composed` telemetry split by provenance and guarded-supplemental
  family summaries
- hosted `contextProfile` narrowing compiled from provider descriptors into
  `sourceSelection`

Stable references:

- `docs/architecture/system-architecture.md`
- `docs/reference/context-composer.md`
- `docs/reference/runtime.md`
- `docs/reference/runtime-plugins.md`
- `docs/reference/events.md`
- `docs/journeys/internal/context-and-compaction.md`

## Stable Contract Summary

The promoted contract is:

1. Context governance uses three non-interchangeable objects.
   Primary registry sources are source-typed runtime providers. Guarded
   supplemental families are post-primary, headroom-governed exception-lane
   blocks. Composer policy blocks are provenance-tagged render artifacts.
2. Primary provider descriptors are the metadata truth.
   Source selection, inspect tooling, and contract tests should derive from the
   provider descriptor surface rather than from duplicated static tables or
   hand-maintained source lists.
3. Hosted profiles are named selection policies over provider descriptors.
   `minimal` means `profileSelectable && continuityCritical`.
   `standard` means `profileSelectable && plane in {history_view,
working_state}`.
   `full` installs no narrowing.
   These are explicit product policies compiled from the provider contract, not
   a second registry and not an unrestricted automatic projection layer.
4. Repo-owned built-ins consume named runtime views or read-model helpers.
   The kernel remains the upstream integration boundary, but broad kernel access
   is no longer the default dependency shape for primary context providers.
5. Exception lanes stay explicit.
   Continuity-bearing source material does not silently migrate into
   `guarded_supplemental`, and composer policy blocks do not widen into a second
   pseudo-source taxonomy.

## Validation Status

Current contract and regression coverage include:

- provider-descriptor inspection through `runtime.inspect.context.listProviders()`
- arena coverage that distinguishes `collectionOrder` from
  `selectionPriority`
- recovery-baseline tests that keep primary admission and inspect on the same
  baseline-budget semantics
- hosted profile tests that compile `sourceSelection` from provider descriptors
- composition telemetry tests that preserve provenance and guarded-supplemental
  family summaries
- stable docs that now use the same context-governance vocabulary across
  runtime, hosted, composer, and internal-journey references

## Source Anchors

- `packages/brewva-runtime/src/context/provider.ts`
- `packages/brewva-runtime/src/context/builtins.ts`
- `packages/brewva-runtime/src/context/dependency-views.ts`
- `packages/brewva-runtime/src/context/arena.ts`
- `packages/brewva-runtime/src/context/injection.ts`
- `packages/brewva-runtime/src/runtime.ts`
- `packages/brewva-runtime/src/services/context.ts`
- `packages/brewva-gateway/src/runtime-plugins/hosted-context-injection-pipeline.ts`
- `packages/brewva-gateway/src/runtime-plugins/context-supplemental.ts`
- `packages/brewva-gateway/src/runtime-plugins/context-composer.ts`
- `packages/brewva-gateway/src/runtime-plugins/context-composer-supplemental.ts`
- `test/contract/runtime/context-source-order.contract.test.ts`
- `test/contract/runtime/recovery-context-baseline.contract.test.ts`
- `test/unit/gateway/hosted-context-injection-pipeline.unit.test.ts`
- `test/unit/gateway/hosted-context-telemetry.unit.test.ts`

## Remaining Backlog

The following ideas are intentionally not part of the promoted contract:

- changing context-budget arithmetic or pressure thresholds
- turning hosted profiles into user-defined selection expressions
- widening guarded supplemental delivery into a second primary-source path
- modeling composer policy blocks as runtime source providers

If those areas become priorities, they should start from a new focused RFC
rather than reopening this promoted pointer as a mixed design-and-rollout note.

## Historical Notes

- Historical option analysis and phased migration detail were removed from this
  file after promotion.
- The stable contract now lives in architecture/reference docs and the
  regression test suite rather than under `docs/research/active/`.
