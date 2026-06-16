---
id: sol-2026-04-19-chinese-tokenized-search-infrastructure
title: Chinese tokenized search infrastructure
status: active
problem_kind: feature
module: brewva-search
boundaries:
  - tools.recall
  - tools.output_search
  - tools.knowledge_search
  - HostedRuntimeAdapterPort.ops.events
  - workbench.memory
source_artifacts:
  - implementation_plan
  - verification_evidence
tags:
  - search
  - tokenizer
  - jieba
  - cjk
updated_at: 2026-04-19
---

# Chinese Tokenized Search Infrastructure

## Context

Brewva previously had search behavior split across session tape search, recall,
output artifact search, knowledge search, and advisory helper tokenization.
That made Chinese queries fragile because CJK text could be treated as one
opaque string, while individual search surfaces each decided whether substring,
fuzzy, or local token overlap mattered.

## Guidance

Use `@brewva/brewva-search` as the only repo-owned search tokenizer boundary.
Consumers should call `tokenizeSearchQuery`, `tokenizeSearchContent`,
`normalizeSearchText`, or `containsCjk` rather than importing `jieba-wasm`
directly or adding package-local tokenization rules.

Chinese tokenization is a mandatory runtime capability. Missing `jieba-wasm`
or missing `jieba_rs_wasm_bg.wasm` is a build/runtime failure, not an
opportunity to fall back to ASCII-only matching.

Use query-side tokenization deliberately. Search queries that compare against
content tokens should disable compound ASCII subtokens to avoid inflating
matches such as `foo-bar` matching unrelated `foo` content. Content/index-side
tokenization can keep compound subtokens so path and identifier searches remain
friendly.

Keep token indexes typed as token arrays when they stay in memory. Avoid
implicit `join(" ")` / `split(/\s+/)` contracts unless crossing a real
serialization boundary. The current knowledge-search corpus stores
`searchTokens` as `string[]` and lets Fuse index that field directly.

Policy validation is part of the same tokenizer boundary. Advisory memory and
contradiction checks should use the shared tokenizer for CJK text and maintain
explicit polarity cues for Chinese policy language, rather than stripping CJK
characters through ASCII-only cleanup.

The shared CJK detector covers the main CJK unified ideograph blocks used by
modern Chinese text plus compatibility ideographs (`U+F900-FAFF`).

## Why This Matters

Search quality is a cross-cutting contract. If tape evidence, recall memory,
knowledge precedents, and output artifacts disagree on token semantics, the
agent cannot reliably reuse prior work. Centralizing tokenization keeps ranking
changes explainable and keeps future indexing upgrades behind one package
boundary.

## When To Apply

Apply this precedent whenever a feature touches:

- `recall_search`
- `output_search`
- `knowledge_search`
- `tape_search`
- workbench or recall retrieval
- advisory policy validation and contradiction checks
- binary packaging of tokenizer assets

Do not add optional Chinese search enhancements locally. Either use the shared
tokenizer or change the shared tokenizer contract and update the affected search
surfaces together.

## References

- `packages/brewva-search/src/index.ts`
- `packages/brewva-search/src/tokenization/tokenizer.ts`
- `packages/brewva-runtime/src/runtime/tape/impl.ts`
- `packages/brewva-recall/src/knowledge/search.ts`
- `script/build-binaries.ts`
- `script/verify-dist.ts`
