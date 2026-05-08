# Decision: Narrative Memory Product and Bounded Semantic Recall

## Metadata

- Decision: Narrative memory and bounded semantic recall are non-authoritative sibling products.
- Date: `2026-04-01`
- Status: accepted
- Stable docs:
  - `docs/architecture/system-architecture.md`
  - `docs/architecture/cognitive-product-architecture.md`
  - `docs/reference/runtime.md`
  - `docs/reference/hosted-dynamic-context.md`
  - `docs/reference/tools.md`
  - `docs/reference/artifacts-and-paths.md`
  - `docs/reference/events/README.md`
  - `docs/guide/features.md`
- Code anchors:
  - `N/A`

## Decision Summary

- Narrative memory as a typed runtime product has been replaced by
  model-authored workbench notes, durable knowledge capture, and on-demand
  recall. None of these are kernel truth.
- Repository-native precedent remains explicit and separate; repeated retrieval is not precedent promotion.
- Model assistance is allowed only for bounded narrative extraction and ambiguity-gated rerank outside the kernel path.
- Recall is explicit and model-requested. No legacy narrative provider performs
  hidden per-turn context admission.

## Superseded by

- `docs/research/decisions/model-operated-working-memory-and-context-governance-reset.md`
