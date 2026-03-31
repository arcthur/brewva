# Research: Deliberation Home And Compounding Intelligence

## Document Metadata

- Status: `promoted`
- Owner: runtime maintainers
- Last reviewed: `2026-03-23`
- Promotion target:
  - `docs/architecture/design-axioms.md`
  - `docs/architecture/cognitive-product-architecture.md`
  - `docs/architecture/system-architecture.md`
  - `docs/reference/runtime.md`
  - `docs/reference/skills.md`
  - `docs/reference/context-composer.md`
  - `docs/reference/tools.md`
  - `docs/journeys/operator/intent-driven-scheduling.md`

## Direct Conclusion

The core conclusion of this RFC has now been implemented:

`Brewva compounds model intelligence by giving deliberation artifacts an explicit home without widening kernel authority.`

The project did not need a thicker kernel or a runtime-owned optimizer.
It needed a stable implementation boundary for:

- evidence-backed deliberation memory
- post-execution skill distillation and promotion
- bounded optimization continuity artifacts

That boundary now exists, and the stable architecture documents listed above
carry the lasting contracts.

## Promotion Summary

This research note is kept as a promoted status pointer.

The accepted design is:

- kernel authority remains narrow
- deliberation artifacts are evidence-backed and non-authoritative
- control-plane products may inspect and present those artifacts
- optimization remains model-native protocol behavior rather than
  runtime-owned planning authority

The main implementation homes are now:

- `@brewva/brewva-deliberation`
  - deliberation memory artifacts
  - optimization continuity artifacts
- `@brewva/brewva-skill-broker`
  - post-execution promotion drafts and review/materialization flow

## What Landed

## 1. A Real Deliberation Home

The repo now has a concrete deliberation implementation boundary instead of an
empty placeholder:

- `packages/brewva-deliberation/src/memory.ts`
- `packages/brewva-deliberation/src/optimization.ts`
- `packages/brewva-deliberation/src/file-store.ts`
- `packages/brewva-deliberation/src/optimization-store.ts`

This is intentionally narrow.
It owns artifact folding, indexing, retrieval, and read-only context exposure.
It does not own kernel commitments, effect authorization, or hidden planning.

## 2. Evidence-Backed Deliberation Memory

The memory plane now folds durable evidence into reusable artifacts such as:

- `repository_strategy_memory`
- `user_collaboration_profile`
- `agent_capability_profile`
- `loop_memory`

Important properties:

- artifacts carry provenance and evidence references
- retrieval uses recency, confidence, and scope-weighted ranking
- hosted sessions expose memory through an internal context source
- memory influences model context but does not become kernel authority

Stable contract landing points:

- `docs/reference/runtime.md`
- `docs/reference/context-composer.md`
- `docs/architecture/system-architecture.md`

## 3. Skill Distillation And Promotion

The repo now has a post-execution promotion path:

- repeated evidence can derive a promotion draft
- drafts can be listed, reviewed, and materialized
- promotion is explicit control-plane behavior, not turn-time skill brokerage

Implemented surfaces:

- `packages/brewva-skill-broker/src/broker.ts`
- `packages/brewva-tools/src/skill-promotion.ts`

Stable contract landing points:

- `docs/reference/tools.md`
- `docs/reference/skills.md`

## 4. Bounded Optimization Continuity

The repo now has an explicit continuity product path for `goal-loop` lineages.

Fold inputs include:

- `goal-loop` outputs
  - `loop_contract`
  - `iteration_report`
  - `convergence_report`
  - `continuation_plan`
- `schedule_intent` events
- lineage-scoped iteration facts

Key behavior:

- inherited child sessions are folded into the same lineage
- `continuityMode=fresh` branches stay separate
- the result is exposed through read-only continuity artifacts
- `optimization_continuity` provides the explicit inspection surface

Implemented surfaces:

- `packages/brewva-deliberation/src/optimization.ts`
- `packages/brewva-tools/src/optimization-continuity.ts`
- hosted provider registration in
  `packages/brewva-gateway/src/host/create-hosted-session.ts`

Stable contract landing points:

- `docs/reference/tools.md`
- `docs/reference/skills.md`
- `docs/journeys/operator/intent-driven-scheduling.md`
- `docs/architecture/cognitive-product-architecture.md`

## Boundary Decisions That Remain In Force

The implementation explicitly preserves the original boundary intent.

Still true:

- tape is commitment memory, not deliberation memory
- truth remains session-scoped kernel authority, not long-term semantic memory
- promotion is post-execution evidence accumulation, not runtime-owned skill
  preselection
- optimization continuity is advisory and inspectable, not a hidden planner
- hosted providers are read-only; sync happens in explicit lifecycle hooks

Still out of scope:

- a runtime-owned optimizer domain
- hidden workflow or loop planners in the default path
- silent mutation of the live skill catalog
- turning deliberation artifacts into commitment truth

## Promotion Criteria Status

The original promotion criteria are now satisfied:

1. deliberation home has a real implementation boundary
2. memory plane has stable artifact contracts and an injection path
3. promotion pipeline can derive and review promotion drafts
4. bounded optimization continuity has a complete product path
5. stable docs now state that:
   - kernel authority is unchanged
   - deliberation memory is non-authoritative
   - promotion is a control-plane behavior
   - optimization remains model-native protocol behavior

## Validation Signals

The design is validated by:

- unit coverage for deliberation memory, skill promotion, and optimization
  continuity
- contract coverage for governance and recovery boundaries
- docs coverage and dist smoke checks
- hosted session lifecycle sync without hidden provider writes

Representative checks:

- `bun run check`
- `bun test --timeout 600000`
- `bun run test:docs`
- `bun run format:docs:check`
- `bun run test:dist`

## Residual Follow-Ups

Promotion does not mean the area is closed forever.

Likely future work:

- richer operator policies on top of retained deliberation artifacts, beyond the
  current pruning bands and explicit memory inspection surface
- stronger optimization forensics and dashboards beyond the current
  `optimization_continuity attention` view
- optional multi-model deliberation layers built on top of these artifacts

Those should remain follow-on design work, not justification for widening
kernel authority.

## Source Anchors

- `packages/brewva-deliberation/src/`
- `packages/brewva-skill-broker/src/`
- `packages/brewva-gateway/src/host/create-hosted-session.ts`
- `packages/brewva-gateway/src/runtime-plugins/deliberation-maintenance.ts`
- `packages/brewva-tools/src/skill-promotion.ts`
- `packages/brewva-tools/src/deliberation-memory.ts`
- `packages/brewva-tools/src/optimization-continuity.ts`
- `packages/brewva-runtime/src/context/sources.ts`
- `packages/brewva-runtime/src/security/control-plane-tools.ts`
- `skills/domain/goal-loop/SKILL.md`
- `skills/meta/self-improve/SKILL.md`
- `docs/architecture/design-axioms.md`
- `docs/architecture/cognitive-product-architecture.md`
- `docs/architecture/system-architecture.md`
- `docs/reference/runtime.md`
- `docs/reference/skills.md`
- `docs/reference/context-composer.md`
- `docs/reference/tools.md`
- `docs/journeys/operator/intent-driven-scheduling.md`
