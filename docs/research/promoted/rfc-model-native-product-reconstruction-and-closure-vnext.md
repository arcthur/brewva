# Research: Model-Native Product Reconstruction And Closure VNext

## Document Metadata

- Status: `promoted`
- Owner: runtime maintainers
- Last reviewed: `2026-03-25`
- Promotion target:
  - `docs/architecture/cognitive-product-architecture.md`
  - `docs/reference/runtime.md`
  - `docs/reference/tools.md`
  - `docs/reference/runtime-plugins.md`
  - `docs/reference/artifacts-and-paths.md`
  - `docs/guide/features.md`

## Promotion Summary

This note is now a status pointer.

The model-native product reset described here has been implemented and promoted
into stable architecture and reference docs.

This reset inherits and narrows:

- [`docs/research/promoted/rfc-boundary-first-subtraction-and-model-native-recovery.md`](./rfc-boundary-first-subtraction-and-model-native-recovery.md)
- [`docs/research/promoted/rfc-default-path-re-hardening-and-advisory-surface-narrowing.md`](./rfc-default-path-re-hardening-and-advisory-surface-narrowing.md)

Implemented direction:

- hosted/provider seams may repair bounded structure and raise explicitly
  configured low tool-output budgets without widening authority
- per-agent self narration is an explicit bundle of `identity.md`,
  `constitution.md`, and `memory.md`
- canonical delegation posture is `explore`, `plan`, `review`, and `general`
  for read-only child work, plus `patch-worker` for isolated writes
- removed legacy profile names such as `researcher`, `reviewer`, and
  `verifier` now fail fast instead of silently coexisting
- capability disclosure is manifest-first and governance-backed
- deliberation memory and optimization continuity refresh live as
  non-authoritative hosted context products
- task closure is split into verification and explicit operator-visible
  acceptance, with acceptance remaining non-rollbackable

Stable references:

- `docs/architecture/cognitive-product-architecture.md`
- `docs/reference/runtime.md`
- `docs/reference/tools.md`
- `docs/reference/runtime-plugins.md`
- `docs/reference/artifacts-and-paths.md`
- `docs/guide/features.md`

## Stable Contract Summary

The promoted contract is:

1. Hosted seam hardening repairs structure, not semantics.
   Provider compatibility may normalize wrapped or truncated tool-call payloads
   and may raise an explicitly present low tool-output budget, but it must not
   invent new authority, bypass tool gating, or guess semantic intent.
2. The self bundle is narrative only.
   `identity.md`, `constitution.md`, and `memory.md` are explicit
   provenance-bearing context providers. They do not become kernel state,
   routing policy, or durable control hints. `HEARTBEAT.md` remains separate
   control-plane material.
3. Delegation uses canonical public posture names.
   The model-facing default language is `explore`, `plan`, `review`, and
   `general`. Removed legacy aliases are not preserved as compatibility
   shims on the built-in surface.
4. Capability disclosure is a scan-friendly exploration surface.
   It shows duty, risk, approval, and rollbackability so the model can see
   available capability without turning disclosure into a routing engine.
5. Deliberation continuity remains admissible context, not authority.
   Live deliberation memory and optimization continuity artifacts may be
   injected after admission, but they remain non-authoritative and inspectable.
6. Closure separates evidence from acceptance.
   Verification answers whether evidence is sufficient. Acceptance answers
   whether the operator accepts closure. When acceptance is required, task
   state advances through `ready_for_acceptance` before `done`.
7. The default hosted path stays planner-free.
   No hidden workflow advisory, lane brief, reminder injection, or prompt-side
   acceptance shortcut is reintroduced by this product reset.

## Validation Evidence

Promotion is backed by repo-local implementation and regression coverage.

Primary validation anchors:

- `test/unit/gateway/provider-compatibility.unit.test.ts`
  - validates bounded tool-call repair and explicit-budget raising
- `test/contract/runtime/identity-context.contract.test.ts`
  - validates self-bundle identity and per-agent narrative context behavior
- `test/unit/gateway/subagent-profiles.unit.test.ts`
  - validates canonical delegated profiles and fail-fast removal of legacy
    profile names
- `test/contract/tools/subagent-run.contract.test.ts`
  - validates the public delegation tool surface against canonical profiles
- `test/contract/extensions/capability-view.contract.test.ts`
  - validates manifest-style capability disclosure, including rollbackability
- `test/unit/deliberation/memory-plane.unit.test.ts`
  - validates live-refresh deliberation memory behavior
- `test/unit/deliberation/optimization-plane.unit.test.ts`
  - validates live-refresh optimization continuity behavior
- `test/contract/runtime/task-ledger.contract.test.ts`
  - validates `ready_for_acceptance` and explicit closure semantics
- `test/contract/tools/task-ledger-tools.contract.test.ts`
  - validates `task_record_acceptance` behavior and fail-fast rejection when
    acceptance is not enabled
- `test/contract/tools/workflow-status.contract.test.ts`
  - validates explicit acceptance posture on the advisory workflow surface

## Follow-Up

- Future product changes in this area should update the promoted references
  above rather than reintroducing a shadow default path here.
- If the canonical delegation posture, self-bundle contract, or closure
  semantics change materially, open a new RFC instead of silently editing the
  promoted contract under this pointer.
