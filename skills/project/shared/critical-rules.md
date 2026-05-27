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
- Treat `receive -> orient -> authorize -> act -> verify -> handoff` as the
  default product-loop grammar for operator and model-facing surfaces, not as a
  runtime state machine.
- Use workspace package imports across package boundaries.
- Do not reintroduce local alias schemes such as `@/...`.
- Do not mix `src` and `dist` class types at public boundaries.
- Do not import from `distribution/**` packages inside workspace package code; treat distribution as release output.
- Keep DuckDB session index state rebuildable and non-authoritative; event tape remains replay authority.
- Keep Work Card inspect as the default operator projection. Context,
  authority, skills, inbox, diff, timeline, and raw replay are explicit
  drill-downs; diagnostic and raw modes are forensic escape hatches, not the
  ordinary inspect surface.
- Preserve "same evidence, different authority": Work Cards, transcripts,
  channel inspect, and hosted dynamic context may orient over the same evidence,
  but kernel admission, capability receipts, sandbox posture, and adoption
  authority remain separate and authoritative.
- Keep Attention Options narrow: `attention_options` returns bounded candidate
  cards, `attention_consume` reveals selected content, `attention_pin` writes
  workbench pins, `attention_ignore` is session-scoped advisory suppression, and
  `attention_verify_plan` returns only a verification recipe. Do not add a
  second memory store or hidden context admission path.
- Keep handoff replayable: `session.handoff` and `tape_handoff` record anchors
  that Work Cards, transcripts, export bundles, channel inspect, and hosted
  context can display without becoming new truth stores.
- Keep SkillCards advisory catalog cards with authority posture `none`. A
  SkillCard, `$skill` mention, or `/skills` catalog entry must not grant tools,
  accounts, budgets, model routes, or a `Run skill` execution path.
- Advisory extension manifests fail closed. `context.contributor` manifests must
  declare `pure`, `read_tape`, or `read_fs`; local hooks stay advisory and must
  not recreate hidden `block_tool` policy.
- Verifier adapters are advisory by default. Kernel defer or abort behavior
  requires an explicit verification gate manifest converted into kernel policy
  input; adapters must not mutate admission or approval state directly.
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
