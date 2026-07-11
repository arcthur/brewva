# Decision: Anchored Edit, Real LSP, And Resource URI Plane

## Metadata

- Decision: Source reads produce line-anchored snapshots, source writes apply only through `SourcePatchPlan`, real LSP `WorkspaceEdit` writes enter the same gate, and internal artifacts are read through the substrate-backed `brewva-resource:///` router.
- Date: `2026-05-24`
- Status: accepted
- Stable docs:
  - `docs/reference/tools.md`
  - `docs/reference/tools/navigation.md`
  - `docs/reference/tools/workflow-and-scheduling.md`
  - `docs/reference/events/tools.md`
  - `docs/journeys/operator/approval-and-rollback.md`
  - `docs/architecture/system-architecture.md`
  - `skills/project/shared/source-map.md`
- Code anchors:
  - `packages/brewva-vocabulary/src/workbench.ts`
  - `packages/brewva-substrate/src/resources/resource-loader.ts`
  - `packages/brewva-substrate/src/resources/resource-router.ts`
  - `packages/brewva-tools/src/families/navigation/source-patch.ts`
  - `packages/brewva-tools/src/families/navigation/grep.ts`
  - `packages/brewva-tools/src/families/navigation/lsp.ts`
  - `packages/brewva-tools/src/families/navigation/lsp-server/`
  - `packages/brewva-tools/src/internal/source-patch-gate.ts`
  - `packages/brewva-tools/src/families/workflow/worker-results.ts`
  - `packages/brewva-tools/src/registry/managed-metadata.ts`
  - `packages/brewva-tools/src/registry/runtime-capability-inventory.ts`
  - `test/contract/runtime/source-patch-protocol.contract.test.ts`
  - `test/contract/tools/tools-real-lsp-surface.contract.test.ts`
  - `test/contract/tools/tools-source-patch.contract.test.ts`
  - `test/unit/substrate/resource-router.unit.test.ts`
  - `test/unit/tools/source-patch-anchor.property.test.ts`

## Decision Summary

- `source_read` is the durable source-reading entrypoint. File-backed reads and
  `grep` record snapshots that render each line as `NN:text` and carry the set of
  displayed lines (`seenLines`) plus normalized line content and file hash for
  runtime validation. An edit intent may only target a line the read displayed.
- `source_patch_prepare` accepts structured edit intents (line-numbered) and
  produces a `SourcePatchPlan`. It validates snapshot existence, seen-line
  coverage (revealing unseen lines on rejection), per-line drift with unique-text
  recovery, generated-file policy, output-path conflicts, and preview diffs before
  any mutation.
- `source_patch_apply` is the only source mutation gate. It accepts a
  `plan_id`, rechecks current file content, writes rollback artifacts, links the
  resulting `PatchSet`, and emits source patch lifecycle events.
- Generated files are hard-rejected for modify, delete, and rename operations.
  This covers common generated markers and path forms instead of relying on
  model discretion.
- LSP tools are true language-server protocol clients. Navigation and
  diagnostics use the server result directly, while rename, file rename, code
  action edits, and formatting convert `WorkspaceEdit` data into
  `SourcePatchPlan` rather than writing directly.
- The old pseudo-LSP and direct AST write paths are removed from the default
  managed tool surface. OXC and source-intelligence remain parser engines under
  non-LSP source-intelligence and summary behavior.
- `brewva-resource:///` is implemented as a provider registry on top of the
  substrate resource loader. The router supports file, skill, agent JSON
  field-path selection, and conflict resources now; memory, MCP, PR, and issue
  providers fail closed until their capabilities are wired.
- `resource_read` is the non-source resource read surface. Source files should
  still use `source_read` so editable snapshots and anchors are explicit.
- Worker-result adoption routes patch application through the same
  `SourcePatchPlan` prepare/apply path, preserving the single mutation gate.
- The runtime capability inventory is generated and checked so new source patch
  and resource read capability leaves fail closed when undeclared.

## Superseded by

- None.
