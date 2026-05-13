---
strength: invariant
scope: anti-patterns
convention_kind: workflow_rule
retirement_sensitivity: review_only
---

# Brewva Anti-Patterns

- Cross-package relative imports such as `../../packages/...`.
- Alias-based import models outside package entrypoints.
- `as any`, `@ts-ignore`, or `@ts-expect-error` quick fixes.
- A mixed top-level runtime implementation surface or bypasses around semantic root surfaces.
- Reintroducing or presenting removed `@brewva/brewva-runtime/internal` helpers as a default integration surface or stable product contract.
- Passing full `BrewvaRuntimeInstance` into leaf modules that only need a root,
  hosted, tool, or operator port.
- Adding managed-tool runtime calls without updating `requiredCapabilities` metadata and scoped-runtime tests.
- Treating `.brewva/session-index/session-index.duckdb` as source-of-truth memory or replay authority.
- Adding user-facing SQL surfaces over the session index before a typed API exists for the product need.
- Adding package-local search tokenizers or optional Chinese-tokenizer fallbacks outside `@brewva/brewva-search`.
- Authoring a second schema source for provider tool arguments instead of
  deriving advisory streaming parse from the canonical TypeBox schema.
- Exporting provider-core streaming parse projection helpers such as
  `partialize` or registry construction as root public APIs.
- Reintroducing mixed provider-core root implementation files or flat
  provider-driver siblings when the accepted shape is domain slices plus
  `providers/<api>/`.
- Fire-and-forget provider session cleanup on session replacement, rewind,
  compaction, or model/provider change.
- Re-exposing removed low-level tuning knobs as public config.
- Editing generated distribution artifacts by hand.
- Skipping `test:dist` for export, CLI, or distribution changes.
