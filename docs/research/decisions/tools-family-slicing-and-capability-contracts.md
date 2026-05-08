# Decision: Tools Family Slicing And Capability Contracts

## Metadata

- Decision: `@brewva/brewva-tools` is family-sliced with centralized capability contracts.
- Date: `2026-05-08`
- Status: accepted
- Stable docs:
  - `docs/architecture/system-architecture.md`
  - `docs/reference/tools.md`
  - `docs/reference/tools/navigation.md`
  - `docs/reference/tools/execution.md`
  - `docs/reference/tools/memory-and-recall.md`
  - `docs/reference/tools/delegation.md`
  - `docs/reference/tools/workflow-and-scheduling.md`
  - `docs/reference/runtime-plugins.md`
  - `skills/project/shared/package-boundaries.md`
  - `skills/project/shared/source-map.md`
- Code anchors:
  - `packages/brewva-tools/src/index.ts`
  - `packages/brewva-tools/src/contracts/`
  - `packages/brewva-tools/src/registry/`
  - `packages/brewva-tools/src/runtime-port/`
  - `packages/brewva-tools/src/bundle/`
  - `packages/brewva-tools/src/families/navigation/api.ts`
  - `packages/brewva-tools/src/families/execution/api.ts`
  - `packages/brewva-tools/src/families/memory/api.ts`
  - `packages/brewva-tools/src/families/delegation/api.ts`
  - `packages/brewva-tools/src/families/workflow/api.ts`
  - `packages/brewva-tools/package.json`
  - `packages/brewva-gateway/src/model-routing/`
  - `test/contract/tools/tools-entrypoint-surface.contract.test.ts`
  - `test/quality/tools-domain-slicing.quality.test.ts`
  - `test/quality/tools-large-adapter-boundary.quality.test.ts`

## Decision Summary

- The tools root exports only default bundle construction at runtime and its
  TypeScript option/result boundary. Deprecated root tool factories,
  forwarding compatibility files, and a factories mega-barrel are intentionally
  not preserved.
- Public tools subpaths are controlled: `/contracts`, `/registry`,
  `/runtime-port`, `/navigation`, `/execution`, `/memory`, `/delegation`, and
  `/workflow`. `bundle/`, family internals, and `shared/` remain private source
  structure.
- `contracts/` owns stable vocabulary only: runtime-port types, metadata,
  surfaces, delegation, A2A, subagent, advisor, and semantic-reranker port
  contracts. Runtime strategies, scoring, rendering, and review synthesis stay
  in the owning family, registry, runtime-port, or private shared helper.
- `registry/` is the single managed-tool capability spine. It owns managed tool
  names, metadata, surfaces, action classes, execution traits, required
  capabilities, descriptor/catalog helpers, and capability-scoped runtime
  facade creation.
- Managed tool factories are bundled through registry-branded factory helpers.
  Missing or undeclared runtime capability access remains fail-closed at
  runtime and is covered by contract tests.
- The five implementation families own concrete adapters: navigation,
  execution, memory, delegation, and workflow. Families may depend on
  `contracts`, `registry`, `runtime-port`, `shared`, and `utils`, but not on
  sibling families except through documented private shared semantics.
- `shared/` is an internal pure-semantic helper root for code used by more than
  one family. It must not depend on runtime ports, hold cross-session state,
  return tool definitions, or own capability policy.
- Large adapters are decomposed inside their owning family so public factories,
  schemas, execution engines, state/lifecycle helpers, and result rendering can
  be reviewed independently.
- Review synthesis and review classification are publicly curated only through
  `@brewva/brewva-tools/delegation`. Workflow tools may consume the shared
  implementation internally but must not expose a second public review surface.
- Model routing policy is gateway-owned through
  `@brewva/brewva-gateway/model-routing`; it is not a tools package concern.
- The heavy navigation parsing/search dependency set remains package-level for
  this decision. Splitting navigation adapters into a separate package or
  optional/lazy dependency model requires a focused follow-up decision.

## Superseded by

- None.
