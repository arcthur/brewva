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
  - `packages/brewva-runtime/src/internal/legacy-runtime/kernel/governance/effect-authority-manifest.ts`
  - `packages/brewva-runtime/src/internal/legacy-runtime/kernel/tools/tool-authorizer.ts`
  - `packages/brewva-runtime/src/internal/legacy-runtime/kernel/tools/tool-access-policy.ts`
  - `packages/brewva-runtime/src/internal/legacy-runtime/kernel/proposals/proposal-admission.ts`
  - `packages/brewva-runtime/src/internal/legacy-runtime/kernel/proposals/proposal-admission-effect-commitment.ts`
  - `packages/brewva-runtime/src/security/command-policy.ts`
  - `packages/brewva-runtime/src/security/virtual-readonly-policy.ts`
  - `packages/brewva-tools/src/registry/capability-scope.ts`

## Decision Summary

- `EffectAuthorityManifest` is the single internal decision owner for effect-authority allow/block/defer outcomes.
- security classifiers, governance overlays, command policy, managed-tool metadata, runtime capability scope, skill posture, repair posture, budget posture, and approval state produce facts rather than independent final decisions.
- hard invariants, host overlays, runtime facts, and receipt requirements are separated in `manifestBasis`.
- `KernelToolAuthorizer` remains the fact collector, manifest caller, commitment orchestrator, and receipt executor.
- `effect_authority_decided` is the canonical decision receipt for new writes. The historical `tool_effect_gate_selected` event remains registered and source-of-truth for replay compatibility with existing tapes.

## Superseded by

- `docs/research/decisions/four-port-runtime-simplification-rfc.md`
