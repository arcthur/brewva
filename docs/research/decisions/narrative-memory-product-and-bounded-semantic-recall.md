# Decision: Narrative Memory Product and Bounded Semantic Recall

## Metadata

- Decision: Narrative memory and bounded semantic recall are non-authoritative sibling products.
- Date: `2026-04-01`
- Status: accepted
- Stable docs:
  - `docs/architecture/system-architecture.md`
  - `docs/architecture/cognitive-product-architecture.md`
  - `docs/reference/runtime.md`
  - `docs/reference/context-composer.md`
  - `docs/reference/tools.md`
  - `docs/reference/artifacts-and-paths.md`
  - `docs/reference/events/README.md`
  - `docs/guide/features.md`
- Code anchors:
  - `N/A`

## Decision Summary

- Narrative memory is a non-authoritative sibling product, not kernel truth and not a subtype of deliberation memory.
- Repository-native precedent remains explicit and separate; repeated retrieval is not precedent promotion.
- Model assistance is allowed only for bounded narrative extraction and ambiguity-gated rerank outside the kernel path.
- Context admission remains deterministic and model-free, while injected narrative recall carries provenance and freshness cues.

## Superseded by

- None.
