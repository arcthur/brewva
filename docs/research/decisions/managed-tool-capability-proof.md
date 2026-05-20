# Decision: Managed Tool Capability Proof

## Metadata

- Decision: Managed tool runtime capabilities are validated against a static leaf-path inventory before runtime proxy construction.
- Date: `2026-05-13`
- Status: accepted
- Stable docs:
  - `docs/reference/tools.md`
  - `docs/reference/runtime.md`
  - `docs/architecture/system-architecture.md`
- Code anchors:
  - `script/generate-tool-runtime-capability-inventory.ts`
  - `packages/brewva-tools/src/registry/runtime-capability-inventory.ts`
  - `packages/brewva-tools/src/registry/capability-scope.ts`
  - `test/unit/tools/runtime-capability-scope.unit.test.ts`

## Decision Summary

- `BREWVA_TOOL_RUNTIME_CAPABILITY_PATHS` is the static proof inventory for managed tool runtime capabilities.
- The inventory is generated from the finite `BrewvaToolRequiredCapability` type union by `bun run tools:capability-inventory`; `bun run check` verifies the generated file is current.
- The inventory contains only leaf paths under `ops.*` and `extensions.tools.*`.
- `authority.*`, `inspect.*`, and `operator.*` are not managed-tool capability namespaces.
- Registry-declared capabilities are validated before scoped runtime proxy construction.
- Unknown paths fail closed without walking live runtime services.

## Superseded by

- None.
