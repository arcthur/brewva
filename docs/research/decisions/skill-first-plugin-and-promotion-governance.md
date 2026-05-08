# Decision: Skill-First, Runtime Plugin, And Promotion Governance

## Metadata

- Decision: Repo-owned hosted integration uses `InternalRuntimePlugin` / `InternalRuntimePluginApi` through `@brewva/brewva-gateway/runtime-plugins`.
- Date: `2026-04-22`
- Status: accepted
- Stable docs:
  - `docs/architecture/system-architecture.md`
  - `docs/architecture/exploration-and-effect-governance.md`
  - `docs/architecture/invariants-and-reliability.md`
  - `docs/reference/runtime-plugins.md`
  - `docs/reference/skill-routing.md`
  - `docs/reference/skills.md`
  - `docs/reference/tools.md`
  - `docs/reference/events/README.md`
- Code anchors:
  - `packages/brewva-gateway/src/runtime-plugins/index.ts`
  - `packages/brewva-substrate/src/host-api/plugin.ts`
  - `packages/brewva-substrate/src/host-api/plugin-runner.ts`
  - `packages/brewva-gateway/src/runtime-plugins/local-hook-port.ts`
  - `packages/brewva-gateway/src/runtime-plugins/skill-first.ts`
  - `packages/brewva-gateway/src/runtime-plugins/tool-surface.ts`
  - `packages/brewva-gateway/src/runtime-plugins/completion-guard.ts`
  - `packages/brewva-tools/src/families/workflow/skill-promotion.ts`

## Decision Summary

- Repo-owned hosted integration uses `InternalRuntimePlugin` / `InternalRuntimePluginApi` through `@brewva/brewva-gateway/runtime-plugins`.
- Internal plugins must declare `RuntimePluginCapability` entries for every mutable surface they use. Undeclared writes fail closed and emit governance evidence.
- `CreateHostedSessionOptions` and `createBrewvaSession(...)` accept `internalRuntimePlugins?` for repo-owned plugins and `localHooks?` for safe local rules. The former raw `runtimePlugins?` public option is not kept as a compatibility alias.
- `LocalHookPort` is the public local-rule surface. `pre_admission` runs after prompt normalization and before TaskSpec derivation, skill-first scoring, context composition, or tool-surface resolution. Classification hints remain advisory inputs.
- `pre_effect` may only block a tool call with a visible reason. It cannot grant permission or widen authority.

## Superseded by

- None.
