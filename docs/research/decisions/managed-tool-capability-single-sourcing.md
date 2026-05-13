# Decision: Managed Tool Capability Single-Sourcing

## Metadata

- Decision: Managed-tool required runtime capabilities are single-sourced in the registry metadata.
- Date: `2026-05-12`
- Status: accepted
- Stable docs:
  - `docs/reference/tools.md`
  - `docs/reference/extensions.md`
  - `skills/project/shared/package-boundaries.md`
- Code anchors:
  - `packages/brewva-tools/src/registry/managed-metadata.ts`
  - `packages/brewva-tools/src/registry/tool.ts`
  - `packages/brewva-tools/src/registry/capability-scope.ts`
  - `packages/brewva-tools/src/contracts/metadata.ts`
  - `packages/brewva-tools/src/contracts/runtime.ts`
  - `packages/brewva-tools/src/runtime-port/target-scope.ts`
  - `test/contract/tools/tool-definition-metadata.contract.test.ts`
  - `test/unit/tools/runtime-capability-scope.unit.test.ts`
  - `test/unit/tools/tool-catalog.unit.test.ts`

## Decision Summary

- `MANAGED_BREWVA_TOOL_METADATA_BY_NAME` is the sole source of required runtime capabilities for managed tools.
- Family adapters must not redeclare `requiredCapabilities`; `defineBrewvaTool(...)` fails fast if adapter-local capabilities are supplied.
- Capability-scoped runtime ports expose `identity`, readonly `config`, `authority`, `inspect`, and declared tool extensions only.
- Managed tools do not receive the operator port. Workbench tools use `authority.workbench.*` because they change model-visible working memory state.
- Capability disclosure is derived from the registry metadata, not from adapter-local declarations.
- Compatibility with adapter-local required-capability declarations is intentionally not preserved.

## Supersedes

- Capability-declaration portions of `docs/research/decisions/tools-family-slicing-and-capability-contracts.md`

## Superseded by

- None.
