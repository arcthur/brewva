# Decision: Multi-Language Source Intelligence

## Metadata

- Decision: Brewva owns in-process multi-language source intelligence under navigation tools and does not adopt the `ast-outline` binary, MCP server, cache, or search stack.
- Date: `2026-06-01`
- Status: accepted
- Stable docs:
  - `docs/reference/tools.md`
  - `docs/reference/tools/navigation.md`
  - `docs/architecture/system-architecture.md`
  - `skills/project/shared/source-map.md`
- Code anchors:
  - `packages/brewva-tools/src/families/navigation/source-intelligence/engine.ts`
  - `packages/brewva-tools/src/families/navigation/source-intelligence/ir.ts`
  - `packages/brewva-tools/src/families/navigation/source-intelligence/tools.ts`
  - `packages/brewva-tools/src/families/navigation/source-intelligence/adapters/`
  - `packages/brewva-tools/src/families/navigation/source-intelligence/graph/`
  - `packages/brewva-tools/src/families/navigation/source-intelligence/grammars/manifest.json`
  - `script/verify-dist.ts`
  - `test/contract/tools/tools-source-intelligence.contract.test.ts`
  - `test/unit/tools/source-intelligence-engine.unit.test.ts`

## Decision Summary

- The public navigation cutover is the `code_*` tool family: outline, digest, surface, dependency, reverse-dependency, cycle, caller, and callee views.
- `toc_*` and duplicate outline-style LSP surfaces are not compatibility aliases.
- TypeScript and JavaScript parsing remain OXC-backed for span-sensitive behavior; non-TypeScript adapters use in-process Tree-sitter grammar assets that distribution smoke tests must package.
- Search tokenization remains centralized in `@brewva/brewva-search`, and digest token accounting routes through `@brewva/brewva-token-estimation`.
- Dependency and call graph confidence is inspect evidence only; ambiguous graph edges cannot authorize source edits or rename.

## Superseded by

- None.
