---
strength: invariant
scope: critical-rules
convention_kind: safety_boundary
retirement_sensitivity: pinned
owner: runtime-maintainers
---

# Brewva Project Critical Rules

- Preserve the `brewva` CLI name and help surface.
- Keep runtime public APIs domain-based, not a flat method bag.
- Do not reintroduce `skills.packs`-style filtering or legacy `base/pack/project` taxonomy.
- Keep runtime governance deterministic and avoid embedding adaptive cognition in the kernel.
- Use workspace package imports across package boundaries.
- Do not reintroduce local alias schemes such as `@/...`.
- Do not mix `src` and `dist` class types at public boundaries.
- Do not import from `distribution/**` packages inside workspace package code; treat distribution as release output.
- Keep DuckDB session index state rebuildable and non-authoritative; event tape remains replay authority.
- Keep search tokenization centralized in `@brewva/brewva-search`; Chinese-aware retrieval depends on mandatory `jieba-wasm`.
- Keep runtime context evidence out of session state. Prompt stability, transient
  reduction, and provider-cache samples live in the context evidence latest
  ring plus hosted evidence sidecars.
- Keep compaction commit single-receipt and async: `session_compact` is the
  durable authority, while history baselines are derived from event tape and
  in-memory cache.
- Keep `infrastructure.contextBudget` on the contracted small surface:
  `enabled`, `thresholds.{hardRatio,advisoryRatio,headroomTokens}`,
  `dynamicTailTokens`, `predictedTurnGrowthTokens`,
  `providerCacheStalenessMs`, `consequenceDigestMaxChars`,
  `compactionInstructions`, and
  `compaction.{minTurnsBetween,protectedTools,tailProtectTokens}`.
