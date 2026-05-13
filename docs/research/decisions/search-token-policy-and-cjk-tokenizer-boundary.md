# Decision: Search Token Policy And CJK Tokenizer Boundary

## Metadata

- Decision: `@brewva/brewva-search` owns repository-wide search normalization, CJK segmentation, and semantic query/content token modes.
- Date: `2026-05-06`
- Status: accepted
- Stable docs:
  - `docs/architecture/system-architecture.md`
  - `docs/reference/tools/memory-and-recall.md`
  - `skills/project/shared/package-boundaries.md`
  - `skills/project/shared/source-map.md`
  - `docs/solutions/search/chinese-tokenized-search-infrastructure.md`
- Code anchors:
  - `packages/brewva-search/src/index.ts`
  - `packages/brewva-search/src/public/index.ts`
  - `packages/brewva-search/src/tokenization/tokenizer.ts`
  - `packages/brewva-search/src/tokenization/ascii.ts`
  - `packages/brewva-search/src/tokenization/cjk.ts`
  - `packages/brewva-search/src/jieba/wasm.ts`
  - `test/fitness/retrieval-spine-boundaries.fitness.test.ts`

## Decision Summary

- Search callers use `tokenizeSearchQuery` for user queries and `tokenizeSearchContent` for indexed content instead of passing raw tokenizer option combinations.
- Compound ASCII subtoken expansion is a search-internal mode policy: query tokenization stays conservative, while content tokenization expands paths and identifiers for indexing.
- CJK tokenization remains mandatory through `jieba-wasm`; missing native assets fail fast rather than silently falling back to ASCII-only search.
- No package outside `@brewva/brewva-search` owns tokenizer mechanics, CJK assets, or compound-token option literals.

## Superseded by

- None.
