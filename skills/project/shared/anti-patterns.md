---
strength: invariant
scope: anti-patterns
---

# Brewva Anti-Patterns

- Cross-package relative imports such as `../../packages/...`.
- Alias-based import models outside package entrypoints.
- `as any`, `@ts-ignore`, or `@ts-expect-error` quick fixes.
- A mixed top-level runtime implementation surface or bypasses around semantic root surfaces.
- Presenting repo-owned `@brewva/brewva-runtime/internal` helpers as a default integration surface or stable product contract.
- Passing raw `BrewvaRuntime` into internal-aware tool factories or rediscovering runtime internals from tool code.
- Adding managed-tool runtime calls without updating `requiredCapabilities` metadata and scoped-runtime tests.
- Treating `.brewva/session-index/session-index.duckdb` as source-of-truth memory or replay authority.
- Adding user-facing SQL surfaces over the session index before a typed API exists for the product need.
- Adding package-local search tokenizers or optional Chinese-tokenizer fallbacks outside `@brewva/brewva-search`.
- Re-exposing removed low-level tuning knobs as public config.
- Editing generated distribution artifacts by hand.
- Skipping `test:dist` for export, CLI, or distribution changes.
