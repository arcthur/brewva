# Research: Boundary-First Subtraction and Model-Native Recovery

## Document Metadata

- Status: `promoted`
- Owner: runtime maintainers
- Last reviewed: `2026-03-25`
- Promotion target:
  - `docs/architecture/design-axioms.md`
  - `docs/architecture/cognitive-product-architecture.md`
  - `docs/architecture/system-architecture.md`
  - `docs/reference/runtime.md`
  - `docs/reference/tools.md`
  - `docs/reference/events.md`

## Promotion Summary

This note is now a short status pointer.

The decision has been promoted: Brewva simplifies by subtraction, not by
feature gating. The runtime and default product path keep only what remains
valuable as models become stronger: effect authorization, durability, replay,
rollback, verification evidence, cost ceilings, and model-native recovery
support.

All seven immediate subtractions listed in the original RFC have been
completed:

1. Judge-based skill preselection and routing traces removed.
   The original `CatalogSkillBroker`, `PiAiSkillBrokerJudge`, and the
   `before_agent_start` extension that chose skills on the model's behalf were
   deleted in `fcbf6ad`. The `@brewva/brewva-skill-broker` package name was
   later reused for a completely different responsibility: post-execution skill
   promotion brokerage landed under the deliberation-home RFC (`3abd3b6`).
   The new package does evidence-backed learning distillation from
   `skill_completed` events and does not perform turn-time path selection.
2. `ExplorationSupervisorService` and `TrustMeterService` removed.
3. `SkillCascadeService`, chain-control tools, and skill-chain event families
   removed. `skills.cascade` config now fails fast with a migration error.
4. Proactive wake heuristics driven by cognition signals removed.
5. Posture taxonomy reduced to `safe` / `effectful`
   (`ToolExecutionBoundary`). `rollbackable` lives as effect metadata and
   receipt semantics rather than as a third execution lane.
6. Debug-loop state machines removed. Verification reports, failure evidence,
   rollback anchors, and repair-oriented context summaries remain.
7. Adaptive and trust-driven context shaping removed. Deterministic admission,
   hard safety limits, and concise turn-brief assembly remain.

Stable references:

- `docs/architecture/design-axioms.md`
- `docs/architecture/cognitive-product-architecture.md`
- `docs/architecture/system-architecture.md`
- `docs/reference/runtime.md`
- `docs/reference/tools.md`
- `docs/reference/events.md`

## Stable Contract Summary

The promoted contract is:

1. Runtime complexity tracks system boundaries, not model compensation.
   If a subsystem mainly predicts or prescribes the next cognitive step, it
   does not belong in the kernel or default host path.
2. Stronger models reduce path prescription, not the need for recovery.
   Review, verification, rollback, and repair evidence remain first-class.
3. Removed control-plane surfaces are deleted rather than toggled off.
   No dormant config switches, shadow profiles, compatibility wrappers, or
   no-op adapters for removed behavior.
4. The default product path stays narrow.
   `CLI -> hosted session -> effect gate -> governed tools -> tape/WAL -> verification/repair`
5. Tape is commitment memory, not a general telemetry sink.

## Package Name Clarification

The original RFC listed `@brewva/brewva-skill-broker` as a deletion target
referring to the judge-based skill preselection system. That system was fully
deleted. The package name was subsequently reused for a post-execution skill
promotion pipeline that belongs to the deliberation-home design
([`docs/research/archive/rfc-deliberation-home-and-compounding-intelligence.md`](../archive/rfc-deliberation-home-and-compounding-intelligence.md)).
The two are
unrelated in purpose:

- deleted: `CatalogSkillBroker` + `PiAiSkillBrokerJudge` + extension
  (turn-time model-compensation routing)
- current: `SkillPromotionBroker` + `FileSkillPromotionStore`
  (post-execution evidence distillation and promotion lifecycle)

## Validation Status

Promotion is backed by:

- all seven subtraction targets verified absent from the current codebase
- `design-axioms.md` adopts "Subtraction beats switches", "Govern effects,
  not thought paths", and "Recovery is model-native, not kernel choreography"
- `skills.cascade` config fails fast with a migration error instead of
  silently accepting dead options
- default hosted session path does not import or wire broker, trust, cascade,
  or cognition-driven proactivity layers
- `ToolExecutionBoundary` is `"safe" | "effectful"` with no third lane
- full repository verification via `bun run check`, `bun test`,
  `bun run test:docs`, and `bun run format:docs:check`

## Remaining Backlog

The following ideas are intentionally not part of the promoted contract:

- reintroducing runtime-owned adaptive planning or model-compensation layers
- compatibility wrappers for removed subsystems
- a return to three-lane posture taxonomy as a public execution model

If those areas become priorities again, they should start from a new focused
RFC rather than reopening this promoted status pointer.

## Historical Notes

- Historical option analysis, design principles, risk analysis, and phased
  rollout details were removed from this file after promotion.
- The stable contract now lives in architecture/reference docs and in the
  regression test suite rather than in `docs/research/`.
