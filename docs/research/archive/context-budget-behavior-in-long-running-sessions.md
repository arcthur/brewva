# Archived Research: Context Budget Behavior In Long-Running Sessions

## Document Metadata

- Status: `archived`
- Owner: runtime and gateway maintainers
- Last reviewed: `2026-05-08`
- Promotion target:
  - `docs/research/decisions/model-operated-working-memory-and-context-governance-reset.md`
  - `docs/research/active/prefix-stable-context-management-and-progressive-compaction.md`
  - `docs/reference/hosted-dynamic-context.md`
  - `docs/reference/token-cache.md`
- Archived on: `2026-05-08`
- Superseded by:
  - `docs/research/decisions/model-operated-working-memory-and-context-governance-reset.md`
  - `docs/research/active/prefix-stable-context-management-and-progressive-compaction.md`
  - `docs/reference/hosted-dynamic-context.md`
  - `docs/reference/token-cache.md`

## Archive Summary

This note investigated long-session context budget behavior under the older
bounded deterministic projection model.

It is archived because the current architecture no longer treats deterministic
projection injection as the primary continuity path. The live contract is:

- numeric context status and predictive overflow nudges
- model-operated workbench notes and evictions
- LLM primary compaction with deterministic emergency fallback
- request-local provider payload reduction
- provider cache evidence and stop-loss reporting

The still-valid material is the requirement to document operator-visible limits
and keep internal budget knobs distinct from public configuration. That work now
belongs in prefix-stability research and stable reference docs.

Read current stable docs and code first. Use this archived note only for
historical context on why long-session budget behavior became a runtime-physics
concern rather than a context-injection policy.
