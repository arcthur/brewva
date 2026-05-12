# Decision: Skill-First, Hosted Extensions, And Promotion Governance

## Metadata

- Decision: Opt-in hosted integration uses `HostedExtensionPlugin` / `HostedExtensionApi` through `@brewva/brewva-gateway/extensions`.
- Date: `2026-04-22`
- Status: accepted
- Stable docs:
  - `docs/architecture/system-architecture.md`
  - `docs/architecture/exploration-and-effect-governance.md`
  - `docs/architecture/invariants-and-reliability.md`
  - `docs/reference/extensions.md`
  - `docs/reference/skill-routing.md`
  - `docs/reference/skills.md`
  - `docs/reference/tools.md`
  - `docs/reference/events/README.md`
- Code anchors:
  - `packages/brewva-gateway/src/hosted/internal/session/host-api-installation.ts`
  - `packages/brewva-substrate/src/host-api/plugin.ts`
  - `packages/brewva-substrate/src/host-api/plugin-runner.ts`
  - `packages/brewva-gateway/src/hosted/internal/session/local-hook-port.ts`
  - `packages/brewva-gateway/src/hosted/internal/session/skill-first.ts`
  - `packages/brewva-gateway/src/hosted/internal/session/tools/tool-surface.ts`
  - `packages/brewva-gateway/src/hosted/internal/session/completion-guard.ts`
  - `packages/brewva-tools/src/families/workflow/skill-promotion.ts`

## Decision Summary

- Opt-in hosted integration uses `HostedExtensionPlugin` / `HostedExtensionApi` through `@brewva/brewva-gateway/extensions`.
- Hosted extensions must declare `HostedExtensionCapability` entries for every mutable surface they use. Undeclared writes fail closed and emit governance evidence.
- `CreateHostedSessionOptions` and `createBrewvaSession(...)` accept `extensions?` for repo-owned plugins and `localHooks?` for safe local rules. The former raw plugin-list public option is not kept as a compatibility alias.
- `LocalHookPort` is the public local-rule surface. `pre_admission` runs after prompt normalization and before TaskSpec derivation, skill-first scoring, context composition, or tool-surface resolution. Classification hints remain advisory inputs.
- `pre_effect` may only block a tool call with a visible reason. It cannot grant permission or widen authority.

## Superseded by

- `docs/research/decisions/model-operated-working-memory-and-context-governance-reset.md`
