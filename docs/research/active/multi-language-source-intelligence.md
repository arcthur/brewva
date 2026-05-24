# Research: Multi-Language Source Intelligence

## Document Metadata

- Status: `active`
- Owner: tools maintainers
- Last reviewed: `2026-05-21`
- Parent note:
  `docs/research/decisions/tools-family-slicing-and-capability-contracts.md`
- External source reviewed:
  `aeroxy/ast-outline` at commit `f5be8d4`
- Oracle policy:
  pinned reference only; no upstream sync is planned
- Promotion target:
  - `docs/reference/tools.md`
  - `docs/reference/tools/navigation.md`
  - `docs/architecture/system-architecture.md`
  - `skills/project/shared/source-map.md`

## Direct Conclusion

Brewva should not adopt `ast-outline` as a binary, MCP server, search backend,
or TypeScript parser replacement.

Brewva should adopt the strongest `ast-outline` ideas as a Brewva-owned,
in-process source intelligence layer inside the navigation tools family:
language-neutral IR, multi-language outline adapters, file-level dependency
graphs, confidence-tagged caller/callee analysis, token-aware digest rendering,
and public-surface analysis for re-exports and barrels.

This RFC is a hard cutover plan. The current `toc_*` tool names, parameters,
and schemas are not preserved. Hard cutover does not relax runtime authority,
receipt, search centralization, package-boundary, CLI launcher, or distribution
invariants.

## Problem Statement

Brewva had a strong TypeScript/JavaScript navigation path before this cutover,
but source intelligence was uneven across languages. Pre-cutover
`toc_document` and `toc_search` used navigation-family cache and Brewva search
tokenization; OXC kept TypeScript/JavaScript parsing in-process; LSP-style
definition/reference and rename paths preserved byte spans and scope safety;
`source_read` now owns hash-anchored precise source reads; and structural search
remains useful only when it feeds Brewva-owned source-intelligence data rather
than direct write paths.

The gaps are multi-language structure and graph awareness: Python, Go, Rust,
Java, C++, and other user languages do not have equivalent outlines; Brewva has
no owned file-level dependency graph, reverse-dependency view, cycle detector,
confidence-tagged call graph, declaration-aware digest, or first-class public
surface result.

`ast-outline` proves these gaps are tractable with a compact IR and language
adapters. Its runtime shape is not directly suitable for Brewva because binary
or MCP integration would bypass managed tool policy, external caches would
escape Brewva provenance, its search subsystem conflicts with
`@brewva/brewva-search`, and replacing OXC would degrade span-sensitive
TypeScript/JavaScript behavior.

## Scope Boundaries

In scope: navigation-family source intelligence IR; multi-language outline for
Python, Go, Rust, Java, and C++; workspace dependency, reverse-dependency, and
cycle tools; confidence-tagged caller/callee graph tools; declaration-aware
digest rendering; TypeScript/JavaScript and Python public API surface tools;
and hard replacement of `toc_*` contracts and duplicated outline-style LSP
surfaces.

Out of scope: replacing OXC, `source_read`, scope-aware rename, or diagnostics;
using `ast-outline` binary/MCP/search/model download paths at runtime; writing
`.ast-outline` or other non-Brewva caches; adding package-local tokenizers,
language-specific tokenizer fallbacks, `madge`, `dependency-cruiser`, `ctags`,
or a full type checker, diagnostics engine, or language server.

## Source Anchors

### Brewva Anchors

- `packages/brewva-tools/src/bundle/default.ts`
- `packages/brewva-tools/src/families/navigation/source-intelligence/engine.ts`
- `packages/brewva-tools/src/families/navigation/source-intelligence/ir.ts`
- `packages/brewva-tools/src/families/navigation/source-intelligence/tools.ts`
- `packages/brewva-tools/src/families/navigation/source-intelligence/cache.ts`
- `packages/brewva-tools/src/families/navigation/source-intelligence/adapters/oxc-typescript.ts`
- `packages/brewva-tools/src/families/navigation/source-intelligence/grammars/manifest.json`
- `packages/brewva-tools/src/families/navigation/lsp.ts`
- `packages/brewva-tools/src/families/navigation/source-patch.ts`
- `docs/research/decisions/tools-family-slicing-and-capability-contracts.md`
- `skills/project/shared/critical-rules.md`
- `skills/project/shared/package-boundaries.md`

The former TOC anchors were legacy surfaces to replace in the hard cutover, not
layers to extend indefinitely.

### `ast-outline` Anchors

- `src/core.rs`: declaration, import, call, and parse-result IR.
- `src/adapters/base.rs`: adapter contract and parser helpers.
- `src/main_helpers.rs`: language dispatch and marker enrichment.
- `src/file_filter.rs`: shared file filtering and ignore handling.
- `src/search/chunker.rs`: declaration-aware chunk packing.
- `src/deps/graph.rs`: forward dependency edges and reverse adjacency.
- `src/deps/extract.rs`: per-language import edge extraction.
- `src/calls/graph.rs`: qualified names, confidence, and call edges.
- `src/calls/resolve.rs`: exact, inferred, and ambiguous call resolution.
- `src/surface/typescript.rs`: package exports, barrels, and re-exports.
- `src/surface/python.rs`: `__all__`, underscore filtering, and re-exports.
- `src/mcp/tools.rs`: useful taxonomy, unsuitable runtime boundary.

## Design Constraints

- Keep production parsing in-process unless a later decision accepts a binary
  dependency and distribution cost.
- Keep managed tool capability policy centralized in the tools registry.
- Keep search tokenization centralized in `@brewva/brewva-search`.
- Keep token estimation centralized in `@brewva/brewva-token-estimation`.
- Keep runtime execution receipt-based and replay-friendly.
- Keep source caches rebuildable, disposable, and under Brewva-owned cache
  boundaries.
- Keep public root exports narrow.
- Keep TypeScript/JavaScript OXC parsing canonical for byte-level spans,
  rename safety, and scope-sensitive behavior.
- Keep parser adapters fail-closed when language, grammar, or capability is
  unavailable.
- Treat ambiguous call graph edges as observation-only. Registry policy must
  prevent `code_callers` and `code_callees` results from becoming direct
  authority for edit or rename tools.
- Keep TypeScript/JavaScript rename on the OXC + scope + MagicString path.
  Source intelligence may provide impact context, but edit authority requires a
  separate refactor-safety decision.

## Decision Options

### Option A: Adopt `ast-outline` Directly

Use the upstream binary or MCP server. This gives the fastest apparent coverage
and a mature command taxonomy, but it adds a second process boundary, moves
cache/provenance outside Brewva control, conflicts with centralized search
tokenization, duplicates OXC, and weakens distribution and capability
enforcement. Verdict: reject for production runtime; keep as a pinned oracle.

### Option B: Build Brewva-Owned Source Intelligence

Create an internal source-intelligence layer under the navigation family. This
preserves Brewva authority, keeps OXC canonical, supports multi-language
structure without a second search system, produces LLM-friendly IR, and keeps
cache/distribution under Brewva control. The cost is adapter fixtures, grammar
asset governance, and public tool redesign. Verdict: preferred long-term path.

### Option C: Stay TypeScript/JavaScript-Only

Improve current OXC-backed TOC and LSP tools without multi-language IR or
graphs. This is low risk, but leaves non-TypeScript repositories structurally
opaque and does not solve blast-radius, public-surface, or caller/callee
analysis. Verdict: insufficient for Brewva's long-term coding-agent goals.

## Proposed Architecture

Create a Brewva-owned source intelligence module inside the navigation family:

```text
packages/brewva-tools/src/families/navigation/source-intelligence/
  adapters/{oxc-typescript,tree-sitter-python,tree-sitter-go,...}.ts
  graph/{calls,dependencies,surface}.ts
  render/{digest,outline}.ts
  grammars/
  cache.ts
  engine.ts
  ir.ts
  language.ts
```

This path should remain internal first. A package split should happen only if
bundle size, grammar packaging, or cross-family reuse proves the boundary is
worth the extra public surface.

Core IR concepts: `SourceDocument`, `SourceDeclaration`, `SourceImport`,
`SourceCall`, `SourceGraphEdge`, and `SourceConfidence`. The IR must carry
language, diagnostics, declarations, imports, local calls, docs, visibility,
modifiers, native kind, byte/line spans, graph evidence, and `exact`,
`inferred`, or `ambiguous` confidence.

## Parser And Distribution Decision

TypeScript/JavaScript use OXC as the canonical parser. Rename and
span-sensitive edits stay on the current OXC + MagicString path.

Non-TypeScript adapters use `web-tree-sitter` with vendored grammar `.wasm`
assets under the source-intelligence module. Grammar assets load through
package-relative `import.meta.url` paths and must be copied into distribution
artifacts. Missing grammar assets disable the affected adapter fail-closed.

Rejected distribution paths: native Tree-sitter Node bindings because native ABI
and binary packaging add avoidable platform risk; runtime grammar downloads
because navigation must work offline and reproducibly; and `ast-outline` binary
delegation because it violates the runtime and capability boundary.

Rejection criterion for the chosen path: if packaged binaries cannot locate
grammar assets without runtime downloads or user path configuration, the
Tree-sitter milestone cannot promote.

Python, Go, and Rust land before Java and C++ because their grammars are mature,
their module systems exercise different resolver paths, fixtures are easy to
build, and they cover a large share of non-TypeScript coding-agent workloads.
Java and C++ follow after the adapter and graph contracts are stable.

## Cache And Invalidation

Cache grain:

- File-level parse cache is canonical.
- Module and workspace graphs are derived snapshots.
- Reverse dependency indexes are derived from forward edges.

Cache keys include workspace root, normalized path, language, parser version,
grammar version, content hash when available, and `mtime + size` as a fallback.

Default storage is in-process LRU shared by target root. Workspace graph tools
may add a private, rebuildable persistent cache under
`.brewva/cache/source-intelligence/`. That cache is not a public format and must
be invalidated by parser version, grammar version, content fingerprint, and
Brewva visible-write or receipt replay epochs.

`fs.watch` and editor events may eagerly invalidate entries, but correctness
must not depend on them.

## Tool Surface And Routing

Hard cutover tool surface: `code_outline` as the default first-touch entry,
`code_digest` for token-budgeted directory/package summaries, `code_surface`
for public API truth, `code_deps`, `code_reverse_deps`, `code_cycles`,
`code_callers`, and `code_callees`.

LLM routing belongs in prompt and skill guidance, not in a generic mega-tool.
`code_outline` is the default language-neutral entry. Separate tools are still
required because digesting, public API truth, dependency graphs, and call graphs
have different result shapes, costs, and safety semantics.

`code_digest` should borrow declaration-aware compression from `ast-outline`
without adopting its search stack. Ranking and tokenization route through
`@brewva/brewva-search`; token estimates route through
`@brewva/brewva-token-estimation`.

Minimum viable digest shape:

```ts
interface CodeDigestResult {
  root: string;
  budget: {
    requestedTokens: number;
    estimatedTokens: number;
    omittedTokens: number;
    estimator: "@brewva/brewva-token-estimation";
  };
  files: Array<{
    path: string;
    language: string;
    declarations: Array<{
      kind: string;
      name: string;
      signature?: string;
      lineStart: number;
      lineEnd: number;
    }>;
    imports?: string[];
    graph?: { fanIn: number; fanOut: number; inCycle: boolean };
    diagnostics?: string[];
    omitted?: { declarations: number; tokens: number };
  }>;
}
```

## Graph, Surface, And Refactor Boundaries

The dependency graph stores forward edges as the canonical cache shape and
derives reverse adjacency on demand. Edges include source file, resolved target
when available, raw module path, import kind, local binding, line, confidence,
and resolver diagnostics.

Call graph resolution is staged:

1. exact local and imported symbol resolution,
2. workspace symbol table resolution when there is one candidate, and
3. dependency-closure constrained resolution for ambiguous names.

Ambiguous results are useful for model awareness, but they cannot authorize
automatic edits. Any edit tool that wants to consume graph output must require
exact spans from parser, LSP, or hash-anchored `source_read` evidence.

Public surface analysis starts with TypeScript/JavaScript and Python:

- TypeScript/JavaScript: package entrypoints, `exports`, `main`, `module`,
  `types`, barrels, named re-exports, namespace re-exports, star exports, and
  index fallback.
- Python: `__all__`, leading-underscore filtering, relative re-exports,
  package `__init__.py`, and star imports when the target module is available.

Rename/refactor ownership remains split intentionally: TypeScript/JavaScript
rename stays on OXC scope analysis, while source intelligence provides
blast-radius context. Moving rename onto source-intelligence IR requires a
future decision with edit-safety proofs.

## Implementation Workstreams

| Workstream                 | Scope                                                                      | Validation                                                                             |
| -------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| IR and dispatch            | IR, language detection, adapter contract, engine dispatch                  | IR normalization, unsupported-language fail-closed tests, managed capability tests     |
| OXC migration              | Map current TypeScript/JavaScript TOC output onto the IR                   | snapshot comparisons, byte-span tests, parse-error behavior, rename isolation          |
| Hard cutover removal       | Remove `toc_*` names and shadowed LSP outline behavior                     | old test cleanup, prompt and skill updates, source-map update, generated docs update   |
| Tree-sitter packaging gate | Prove `web-tree-sitter` plus vendored grammar assets in packaged artifacts | language fixtures, parser diagnostics, packaged grammar smoke tests, timing baselines  |
| Non-TypeScript adapters    | Python, Go, and Rust outline/digest support                                | oracle comparisons, fixture snapshots, distribution smoke tests                        |
| Tool surface               | Introduce `code_*` schemas and managed metadata                            | generated schemas, read observations, session cache tests                              |
| Dependency graph           | Import extraction, resolution, reverse adjacency, cycles                   | resolver fixtures, graph determinism, cycle tests, unresolved-edge accounting          |
| Call graph                 | Raw call extraction and staged confidence resolution                       | exact/imported/ambiguous cases, dependency-closure inference, edit-safety tests        |
| Public surface             | TypeScript/JavaScript and Python public API analysis                       | barrel fixtures, `__all__` fixtures, unresolved export diagnostics, oracle comparisons |

## Surface Budget

This RFC changes public tool concepts and inspection behavior. It requires
tools maintainer review before promotion.

| Surface                               | Before | After | Notes                                                                                                                                                         |
| ------------------------------------- | -----: | ----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Required authored fields              |      0 |     0 | Tool inputs remain generated schemas, not handwritten config.                                                                                                 |
| Optional authored fields              |      0 |     0 | No new user-authored config is proposed.                                                                                                                      |
| Author-facing concepts                |      4 |     8 | Pre-cutover `toc_document`, `toc_search`, `lsp_*`, and `ast-grep` concepts become outline, digest, surface, deps, reverse deps, cycles, callers, and callees. |
| Inspect surfaces                      |      0 |     3 | Dependency graph, call graph, and parser diagnostics become inspectable results.                                                                              |
| Routing/control-plane decision points |      0 |     0 | Language dispatch is automatic and fail-closed.                                                                                                               |
| Public tool/API surfaces              |      4 |     8 | Existing navigation concepts are replaced in one hard cutover.                                                                                                |

Positive concept delta:

- Debt owner: tools maintainers.
- Why unavoidable: one unified `code` tool would create a mode-heavy command
  with incompatible budgets, output shapes, and safety policies. Separate tools
  keep the LLM routeable surface explicit and allow registry policy to enforce
  edit-safety boundaries.
- Re-evaluation trigger: `2026-08-21` or after the first three non-TypeScript
  language adapters are promoted, whichever comes first.

## Validation Signals

Required verification before promotion:

- `bun run test:docs`
- `bun run format:docs:check`
- `bun run check`
- `bun test`
- `bun run test:dist` when grammar assets or distribution metadata change
- `bun run build:binaries` when grammar assets affect packaged binaries
- distribution help and grammar-parse smoke when the CLI-visible tool surface
  changes

Required test classes: adapter fixtures, IR snapshots, `ast-outline` oracle
comparisons for shared Python/Go/Rust fixtures, reviewed-delta tests when
Brewva intentionally differs from the oracle, graph determinism, dependency
cycles, confidence-tagged call resolution, ambiguous-edge edit-safety,
search-tokenization boundary tests, token-estimation boundary tests, cache
invalidation, and managed capability fail-closed tests.

Operational signals: parse latency by language, persistent cache hit rate,
parser diagnostic rate, unresolved dependency edge rate, ambiguous call edge
rate, digest omitted-token accounting, and tool-result size distribution.

## Promotion Criteria

This note can promote when:

1. TypeScript/JavaScript source intelligence is backed by OXC and does not
   regress byte spans, rename safety, or read observations.
2. The `toc_*` tool names, parameter schemas, and result schemas are removed
   rather than preserved as compatibility aliases.
3. At least three non-TypeScript languages have tested `code_outline` and
   `code_digest` support.
4. Dependency graph tools support forward edges, reverse edges, cycle
   detection, and unresolved-edge diagnostics.
5. Caller/callee tools return `exact`, `inferred`, and `ambiguous` confidence
   where applicable.
6. Ambiguous call graph edges are blocked from edit or rename authority by
   registry-level policy.
7. `code_surface` supports TypeScript/JavaScript barrels and Python `__all__`.
8. No runtime path depends on the `ast-outline` binary, MCP server, external
   cache, search subsystem, or model download path.
9. Search tokenization still routes through `@brewva/brewva-search`.
10. Digest token estimates route through `@brewva/brewva-token-estimation`.
11. Grammar assets pass distribution verification without runtime downloads.
12. Stable tool docs include a search-boundary cross-reference so `code_digest`
    is not presented as a replacement search subsystem.
13. Stable tool docs and architecture docs carry the promoted contract.

## Open Questions

- Should source intelligence remain navigation-internal permanently?
- Which optional `code_digest` detail fields should be included after the
  minimum viable shape lands?
- Should Rust surface visibility ship in the first graph milestone or later?
- What proof is required before any non-TypeScript rename tool can consume
  source-intelligence graph output?

## Near-Term Recommendation

Start with Option B. The first milestone is IR and OXC migration plus hard
cutover planning. The second milestone is the Tree-sitter packaging gate. Only
after that should Python, Go, and Rust outline/digest adapters land. Dependency
graph, caller/callee, and public surface should ship as separate workstreams,
not as hidden behavior inside `code_outline`.
