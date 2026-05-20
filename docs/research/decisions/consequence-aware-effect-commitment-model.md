# Decision: Consequence-Aware Effect Commitment Model

## Metadata

- Decision: runtime governance owns consequence-aware effect commitment posture, projection, and operator/model disclosure.
- Date: `2026-05-13`
- Status: accepted
- Stable docs:
  - `docs/reference/configuration.md`
  - `docs/reference/events/tools.md`
  - `docs/reference/hosted-dynamic-context.md`
  - `docs/reference/runtime.md`
  - `docs/reference/skills.md`
  - `docs/reference/tools.md`
- Code anchors:
  - `packages/brewva-runtime/src/runtime/kernel/policy/effect-posture.ts`
  - `packages/brewva-runtime/src/internal/legacy-runtime/kernel/governance/effect-authority-manifest.ts`
  - `packages/brewva-runtime/src/read-models/projection/effects/`
  - `packages/brewva-runtime/src/internal/legacy-runtime/tape/event-ops/runtime-surface.ts`
  - `packages/brewva-runtime/src/internal/legacy-runtime/model/skills/tier-policy.ts`
  - `packages/brewva-gateway/src/hosted/internal/context/workbench-context.ts`
  - `packages/brewva-gateway/src/hosted/internal/context/capability-view.ts`
  - `packages/brewva-gateway/src/hosted/internal/context/materialization.ts`
  - `packages/brewva-runtime/src/config/types.ts`

## Decision Summary

- Keep `ToolEffectClass` as the stable domain axis for what world a tool touches.
- Add `EffectCommitmentPosture` as the derived consequence axis: recoverability plus visibility, backed by evidence and warnings.
- Replace the old single-bit rollback governance posture with `ToolRecoveryPreparation` plus receipt-backed posture derivation.
- Use `brewva.effect_authority_basis.v2` as the effect authority manifest basis; old v1 basis and single-bit recovery wording are not compatibility surfaces.
- Runtime owns per-turn effect commitment projection and inspect surfaces. Gateway only renders the bounded `[TurnConsequenceDigest]` model context block.
- `inspect.events.effects.getTurnProjection` is the structured operator view; `inspect.events.effects.renderTurnDigest` is the bounded model-facing view.
- Consequence digest budget is deployment-configurable through `infrastructure.contextBudget.consequenceDigestMaxChars`.
- Managed-tool `requiredCapabilities` remain hard enforcement. Capability and consequence disclosure are separate from implementation authority.
- Skill tiers are directory-derived policy surfaces. Skill metadata remains advisory and cannot exceed tier ceilings.

## Superseded by

- `docs/research/decisions/four-port-runtime-simplification-rfc.md`
