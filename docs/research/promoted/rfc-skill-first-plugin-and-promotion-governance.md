# Research: Skill-First, Runtime Plugin, And Promotion Governance

## Document Metadata

- Status: `promoted`
- Owner: runtime and gateway maintainers
- Last reviewed: `2026-04-22`
- Promotion target:
  - `docs/architecture/system-architecture.md`
  - `docs/architecture/exploration-and-effect-governance.md`
  - `docs/architecture/invariants-and-reliability.md`
  - `docs/reference/runtime-plugins.md`
  - `docs/reference/skill-routing.md`
  - `docs/reference/skills.md`
  - `docs/reference/tools.md`
  - `docs/reference/events.md`
  - `docs/reference/configuration.md`

## Promotion Summary

This research note is now a promoted status pointer.

The accepted decision is:

- internal runtime plugins and local hooks are separate extension tiers
- repo-owned internal plugins are manifest objects with declared write
  capabilities
- local hooks use the narrow `LocalHookPort` phases:
  `pre_classify`, `pre_tool`, `post_tool`, and `end_turn`
- local hooks may observe, recommend, block a tool call, or record advisory
  local information, but they may not rewrite prompts, provider payloads, tool
  results, message visibility, active tools, authority, or persisted truth
- skill-first now reports semantic activation posture separately from tool
  availability posture
- exploratory and analytical turns receive recommendations without losing the
  normal read/search/mutation/lifecycle surface
- execution, verification, mutation, and failed-contract cases may still narrow
  the visible tool surface through explicit posture
- completion guard no longer hides routine skill-load skips or makes draft
  disappearance part of normal skill routing
- skill promotion is a durable proposal pipeline, not a live self-modification
  path
- `skill_promotion_apply` is a reserved protocol name and is intentionally not
  registered as a live tool
- `turn_governance_decision` is the aggregate explanation receipt for hook,
  plugin, skill-first, tool-surface, completion-guard, and promotion-governance
  decisions

## Stable References

- `docs/architecture/system-architecture.md`
- `docs/architecture/exploration-and-effect-governance.md`
- `docs/architecture/invariants-and-reliability.md`
- `docs/reference/runtime-plugins.md`
- `docs/reference/skill-routing.md`
- `docs/reference/skills.md`
- `docs/reference/tools.md`
- `docs/reference/events.md`
- `docs/reference/configuration.md`

## Stable Contract Summary

The promoted contract is:

1. Repo-owned hosted integration uses `InternalRuntimePlugin` /
   `InternalRuntimePluginApi` through
   `@brewva/brewva-gateway/runtime-plugins`.
2. Internal plugins must declare `RuntimePluginCapability` entries for every
   mutable surface they use. Undeclared writes fail closed and emit governance
   evidence.
3. `CreateHostedSessionOptions` and `createBrewvaSession(...)` accept
   `internalRuntimePlugins?` for repo-owned plugins and `localHooks?` for safe
   local rules. The former raw `runtimePlugins?` public option is not kept as a
   compatibility alias.
4. `LocalHookPort` is the public local-rule surface. `pre_classify` runs after
   prompt normalization and before TaskSpec derivation, skill-first scoring,
   context composition, or tool-surface resolution. Classification hints remain
   advisory inputs.
5. `pre_tool` may only block a tool call with a visible reason. It cannot grant
   permission or widen authority.
6. `post_tool` receives a cloned snapshot of normalized result content,
   details, and error posture. Mutating that snapshot or returning extra fields
   cannot rewrite the model-visible tool result.
7. `end_turn` may observe and recommend after completion guard has run, but it
   cannot suppress assistant output or rewrite transcript visibility.
8. Skill routing returns `SkillActivationPosture` and
   `ToolAvailabilityPosture` instead of a single gate-mode enum.
9. The tool surface matrix is:

| Tool availability posture | Read/search tools | Mutation tools | Lifecycle tools |
| ------------------------- | ----------------- | -------------- | --------------- |
| `none`                    | visible           | visible        | visible         |
| `recommend`               | visible           | visible        | visible         |
| `require_explore`         | visible           | hidden         | visible         |
| `require_execute`         | hidden            | hidden         | visible         |
| `contract_failed`         | hidden            | hidden         | repair only     |

10. Tool-surface filtering uses semantic action policy and declared routing
    scopes, not tool-name heuristics. `local_exec_readonly` remains gated until
    a later command-policy RFC proves it safe.
11. Completion guard uses visible recommendation or repair notices. Routine
    skill recommendations do not return `display:false` or
    `excludeFromContext:true`.
12. Skill promotion is split by authority:
    - `skill_promotion_inspect` reads cached drafts and remains control-plane
      observation
    - `skill_promotion_review` records operator review decisions and uses
      operator-scoped memory-write governance
    - `skill_promotion_promote` materializes review packets under
      `.brewva/skill-broker/materialized/<draft-id>/` and uses operator-scoped
      workspace-patch governance
    - `skill_promotion_apply` is reserved and absent from the default bundle,
      managed registry, action policy, and control-plane tools
13. Stable docs, runtime events, and tests are the normative contract. This
    promoted note preserves rationale and migration breadcrumbs only.

## Current Implementation Notes

- `packages/brewva-gateway/src/runtime-plugins/index.ts` exports
  `InternalRuntimePlugin`, `InternalRuntimePluginApi`,
  `RuntimePluginCapability`, `LocalHookPort`, and
  `defineInternalRuntimePlugin(...)`.
- `packages/brewva-substrate/src/host-api/plugin.ts` defines the internal host
  plugin manifest and capability vocabulary.
- `packages/brewva-substrate/src/host-api/plugin-runner.ts` enforces declared
  capabilities for system prompt, context messages, provider payload, input
  parts, tool-call blocking, tool-result rewrites, message visibility, and
  queued assistant/user messages.
- `packages/brewva-gateway/src/runtime-plugins/local-hook-port.ts` adapts safe
  local hooks into the hosted lifecycle and records governance decisions.
- `packages/brewva-gateway/src/runtime-plugins/skill-first.ts` owns
  `SkillActivationPosture` and `ToolAvailabilityPosture`.
- `packages/brewva-gateway/src/runtime-plugins/tool-surface.ts` resolves
  visible tools from posture, action policy, routing scopes, active skills,
  operator profile, and lifecycle needs.
- `packages/brewva-gateway/src/runtime-plugins/completion-guard.ts` emits
  visible recommendation and repair notices instead of routine assistant-draft
  suppression.
- `packages/brewva-tools/src/skill-promotion.ts` implements inspect, review,
  and promote only.
- `packages/brewva-runtime/src/governance/action-policy.ts` classifies
  `skill_promotion_review` and `skill_promotion_promote` behind
  `operator` / `meta` routing scopes.
- `packages/brewva-runtime/src/security/control-plane-tools.ts` keeps only
  `skill_promotion_inspect` in the always-available control-plane set.
- `docs/reference/events.md` documents `skill_diagnosis_derived`,
  `tool_surface_resolved`, and `turn_governance_decision` as the inspectable
  governance receipts for this area. The original promoted receipt name,
  `skill_recommendation_derived`, was retired by the Product Semantic
  Compression RFC when the default recommendation surface became diagnosis.

## Validation Status

Promotion is backed by:

- substrate plugin-runner contract coverage for undeclared write failures and
  declared write success paths
- runtime-plugin entrypoint coverage proving only the new internal/local hook
  symbols are public on the runtime-plugin subpath
- hosted turn-pipeline coverage proving `pre_classify` runs before tool-surface
  resolution and local hook blocks are receipted before runtime authority starts
- local `post_tool` coverage proving hook-visible result snapshots cannot
  mutate normalized tool results
- tool-surface contract coverage for advisory recommendations,
  `require_explore`, `require_execute`, failed-contract repair, operator
  routing scopes, dynamic managed-tool registration, and skill-scoped routing
  scope filtering
- completion-guard unit coverage proving routine skill recommendations remain
  visible and repair paths leave visible governance evidence
- skill-promotion unit coverage for cached inspect, operator review,
  materialized promotion packets, and non-injection after promotion
- managed tool metadata contract coverage proving `skill_promotion_apply`
  remains absent from live tool surfaces and action policy
- event-level coverage proving the new governance events are registered and
  documented
- docs quality coverage for runtime plugins, skill routing, skills, tools,
  events, configuration, research indexes, and markdown links

Representative anchors:

- `test/contract/substrate/host-plugin-runner.contract.test.ts`
- `test/contract/runtime-plugins/hosted-turn-pipeline.contract.test.ts`
- `test/contract/runtime-plugins/runtime-plugin-tool-surface.contract.test.ts`
- `test/contract/tools/tool-definition-metadata.contract.test.ts`
- `test/unit/gateway/completion-guard.unit.test.ts`
- `test/unit/tools/skill-promotion.unit.test.ts`
- `test/quality/docs/reference-runtime-plugins-coverage.quality.test.ts`
- `test/quality/docs/reference-events-coverage.quality.test.ts`
- `test/quality/docs/research-index-consistency.quality.test.ts`

## Remaining Backlog

The following ideas are intentionally not part of the promoted contract:

- live `skill_promotion_apply`; it needs explicit diff review, operator
  approval UI, rollback metadata, and audit contracts before registration
- a command-policy RFC that could eventually classify a narrow
  `local_exec_readonly` grammar as ordinary read/search posture
- third-party plugin sandboxing beyond the current local hook port
- richer operator UI for reading `turn_governance_decision` receipts without
  querying raw events
- additional telemetry to decide whether advisory skill recommendations should
  become more or less aggressive for specific project profiles

If any of these need stronger guarantees, start a new focused RFC instead of
expanding this promoted note back into an active roadmap.

## Historical Notes

- The active RFC originally compared the old hard skill-first gate,
  shadow-runtime plugin powers, hidden completion suppression, and monolithic
  `skill_promotion` tool as one coupled risk area.
- The implementation intentionally chose a breaking architecture pass:
  compatibility aliases for old runtime plugin names, old gate enums, and old
  `skill_promotion` action multiplexing were not retained.
- Promotion removes the old option analysis and migration sequencing from
  `active/`; stable docs and tests are now the source of truth for the accepted
  contract.
