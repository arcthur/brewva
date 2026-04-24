---
strength: invariant
scope: critical-rules
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
