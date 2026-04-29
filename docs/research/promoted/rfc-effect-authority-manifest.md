# Research: Effect Authority Manifest

## Document Metadata

- Status: `promoted`
- Owner: runtime and gateway maintainers
- Last reviewed: `2026-04-29`
- Promotion target:
  - `docs/architecture/system-architecture.md`
  - `docs/architecture/exploration-and-effect-governance.md`
  - `docs/architecture/invariants-and-reliability.md`
  - `docs/reference/exec-threat-model.md`
  - `docs/reference/proposal-boundary.md`
  - `docs/reference/runtime.md`
  - `docs/reference/tools.md`
  - `docs/reference/events.md`

## Promotion Summary

This note is now a promoted status pointer.

The accepted decision is:

- `EffectAuthorityManifest` is the single internal decision owner for
  effect-authority allow/block/defer outcomes.
- security classifiers, governance overlays, command policy, managed-tool
  metadata, runtime capability scope, skill posture, repair posture, budget
  posture, and approval state produce facts rather than independent final
  decisions.
- hard invariants, host overlays, runtime facts, and receipt requirements are
  separated in `manifestBasis`.
- `ToolGateService` remains the fact collector, manifest caller, commitment
  orchestrator, and receipt executor.
- `effect_authority_decided` is the canonical decision receipt for new writes.
  The historical `tool_effect_gate_selected` event remains registered and
  source-of-truth for replay compatibility with existing tapes.
- proposal admission keeps pending/resume/delegation/request history, while
  approval requirement, receipt requirement, and authority basis come from the
  same manifest-backed decision as direct tool execution.
- runtime capability declarations remain independent from action-policy rows.
  Capability denial is visible in the manifest explanation, but it does not
  change the action-class graph.
- `local_exec_readonly` auto-allow requires both command-policy read-only
  acceptance and the `virtual_readonly` execution route. That route requirement
  is invariant, not a host overlay.

## Stable References

- `docs/architecture/system-architecture.md`
- `docs/architecture/exploration-and-effect-governance.md`
- `docs/architecture/invariants-and-reliability.md`
- `docs/reference/exec-threat-model.md`
- `docs/reference/proposal-boundary.md`
- `docs/reference/runtime.md`
- `docs/reference/tools.md`
- `docs/reference/events.md`

## Current Implementation Notes

Implemented anchors:

- `packages/brewva-runtime/src/authority/effect-authority-manifest.ts`
- `packages/brewva-runtime/src/services/tool-gate.ts`
- `packages/brewva-runtime/src/services/tool-access-policy.ts`
- `packages/brewva-runtime/src/services/proposal-admission.ts`
- `packages/brewva-runtime/src/services/proposal-admission-effect-commitment.ts`
- `packages/brewva-runtime/src/security/command-policy.ts`
- `packages/brewva-runtime/src/security/virtual-readonly-policy.ts`
- `packages/brewva-tools/src/runtime-capability-scope.ts`

The implementation intentionally removes the older live decision path. Direct
tool authorization and proposal admission now share `manifestBasis`; reviewers
should treat any future direct policy bypass as a fail-closed regression. Tape
replay still recognizes historical `tool_effect_gate_selected` receipts because
event tape remains replay authority.

This change co-landed with
`docs/research/promoted/rfc-turn-lifecycle-spine.md`. The manifest is the
decision adapter for the spine's `effect_authorized` gate; the spine does not
own action policy, approval policy, or receipt requirement semantics.

## Validation Status

Promotion is backed by:

- unit coverage for manifest decisions, capability denials, approval
  requirements, and `local_exec_readonly` invariant handling
- proposal contract coverage asserting `manifestBasis` is shared with
  commitment admission
- tool-invocation characterization coverage asserting
  `effect_authority_decided` is the canonical authority receipt
- docs coverage for the stable event and reference surface

## Non-Goals

- Adding public runtime root methods.
- Reopening action-class vocabulary.
- Treating runtime capability declarations as action-policy rows.
- Replacing the v1 flat `manifestBasis` lists with provenance triples; richer
  per-layer provenance needs a focused follow-on RFC.
- Moving the transaction boundary above one tool call.
- Adding cross-agent saga, compensation, or multi-agent transaction semantics.

## Closed Implementation Posture

This RFC has no remaining open design questions. Future changes that add new
effect classes, persisted receipt fields, or public authorization surfaces
should start from a new focused RFC rather than widening this promoted pointer.
