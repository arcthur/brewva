# Decision: Effect Authority Manifest

## Metadata

- Decision: `EffectAuthorityManifest` is the single internal decision owner for effect-authority allow/block/defer outcomes.
- Date: `2026-04-29`
- Status: accepted
- Stable docs:
  - `docs/architecture/system-architecture.md`
  - `docs/architecture/exploration-and-effect-governance.md`
  - `docs/architecture/invariants-and-reliability.md`
  - `docs/reference/exec-threat-model.md`
  - `docs/reference/proposal-boundary.md`
  - `docs/reference/runtime.md`
  - `docs/reference/tools.md`
  - `docs/reference/events/README.md`
- Code anchors:
  - `packages/brewva-runtime/src/authority/effect-authority-manifest.ts`
  - `packages/brewva-runtime/src/services/tool-gate.ts`
  - `packages/brewva-runtime/src/services/tool-access-policy.ts`
  - `packages/brewva-runtime/src/services/proposal-admission.ts`
  - `packages/brewva-runtime/src/services/proposal-admission-effect-commitment.ts`
  - `packages/brewva-runtime/src/security/command-policy.ts`
  - `packages/brewva-runtime/src/security/virtual-readonly-policy.ts`
  - `packages/brewva-tools/src/runtime-capability-scope.ts`

## Decision Summary

- `EffectAuthorityManifest` is the single internal decision owner for effect-authority allow/block/defer outcomes.
- security classifiers, governance overlays, command policy, managed-tool metadata, runtime capability scope, skill posture, repair posture, budget posture, and approval state produce facts rather than independent final decisions.
- hard invariants, host overlays, runtime facts, and receipt requirements are separated in `manifestBasis`.
- `ToolGateService` remains the fact collector, manifest caller, commitment orchestrator, and receipt executor.
- `effect_authority_decided` is the canonical decision receipt for new writes. The historical `tool_effect_gate_selected` event remains registered and source-of-truth for replay compatibility with existing tapes.

## Superseded by

- None.
