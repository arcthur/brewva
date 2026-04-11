# Promoted Research Notes

`docs/research/promoted/` stores concise status pointers for accepted research
work. The lasting contract lives in stable docs and code; these notes exist to
preserve rationale, scope boundaries, and follow-on guidance without keeping
every RFC in the top-level docs index.

Read stable docs first. Use promoted notes when you need:

- the original design boundary in one place
- explicit non-goals that stable docs now assume
- migration breadcrumbs for why the stable contract looks the way it does

When you need full superseded proposal detail, read
[`docs/research/archive/README.md`](../archive/README.md) or inspect git
history. Promoted notes may keep short `Historical Notes`, but they should not
grow back into long-form archived RFCs.

Governance rule: a promoted note is a status pointer, not a second normative
spec. If the stable contract changes, update the stable docs first and then
refresh the pointer summary and `Last reviewed` metadata here.

## Runtime Shape And Policy

- [`rfc-architecture-doc-precision-review.md`](./rfc-architecture-doc-precision-review.md)
- [`rfc-authority-surface-narrowing-and-runtime-facade-compression.md`](./rfc-authority-surface-narrowing-and-runtime-facade-compression.md)
- [`rfc-boundary-first-subtraction-and-model-native-recovery.md`](./rfc-boundary-first-subtraction-and-model-native-recovery.md)
- [`rfc-boundary-policy-credential-vault-and-loop-guard.md`](./rfc-boundary-policy-credential-vault-and-loop-guard.md)
- [`rfc-capability-compression-and-output-distillation.md`](./rfc-capability-compression-and-output-distillation.md)
- [`rfc-default-path-re-hardening-and-advisory-surface-narrowing.md`](./rfc-default-path-re-hardening-and-advisory-surface-narrowing.md)
- [`rfc-durability-taxonomy-and-rebuildable-surface-narrowing.md`](./rfc-durability-taxonomy-and-rebuildable-surface-narrowing.md)
- [`rfc-iteration-facts-and-model-native-optimization-protocols.md`](./rfc-iteration-facts-and-model-native-optimization-protocols.md)
- [`rfc-repository-fitness-plane-and-runtime-boundary.md`](./rfc-repository-fitness-plane-and-runtime-boundary.md)
- [`rfc-workflow-artifacts-and-posture-control-plane.md`](./rfc-workflow-artifacts-and-posture-control-plane.md)

## Delegation, Product, And Knowledge

- [`rfc-inspectable-operator-experience-overlays.md`](./rfc-inspectable-operator-experience-overlays.md)
- [`rfc-kernel-level-reasoning-revert-and-branch-continuity.md`](./rfc-kernel-level-reasoning-revert-and-branch-continuity.md)
- [`rfc-model-native-product-reconstruction-and-closure-vnext.md`](./rfc-model-native-product-reconstruction-and-closure-vnext.md)
- [`rfc-narrative-memory-product-and-bounded-semantic-recall.md`](./rfc-narrative-memory-product-and-bounded-semantic-recall.md)
- [`rfc-repository-native-compound-knowledge-and-review-ensemble.md`](./rfc-repository-native-compound-knowledge-and-review-ensemble.md)
- [`rfc-skill-distribution-refresh-and-catalog-surface.md`](./rfc-skill-distribution-refresh-and-catalog-surface.md)
- [`rfc-skill-contract-layering-project-context-and-explicit-activation.md`](./rfc-skill-contract-layering-project-context-and-explicit-activation.md)
- [`rfc-specialist-subagents-and-adversarial-verification.md`](./rfc-specialist-subagents-and-adversarial-verification.md)
- [`rfc-tool-search-advisor-and-auto-broadened-discovery.md`](./rfc-tool-search-advisor-and-auto-broadened-discovery.md)

## Gateway, Session, And Scheduling

- [`rfc-derived-session-wire-schema-and-frontend-session-protocol.md`](./rfc-derived-session-wire-schema-and-frontend-session-protocol.md)
- [`rfc-gateway-experience-ring-decomposition.md`](./rfc-gateway-experience-ring-decomposition.md)
- [`rfc-hosted-turn-transitions-and-bounded-recovery.md`](./rfc-hosted-turn-transitions-and-bounded-recovery.md)
- [`rfc-preparse-normalization-model-capability-and-live-audit-split.md`](./rfc-preparse-normalization-model-capability-and-live-audit-split.md)
- [`rfc-schedule-intent-hardening-and-control-plane-ergonomics.md`](./rfc-schedule-intent-hardening-and-control-plane-ergonomics.md)

## Reading Rule

If a promoted note and a stable architecture/reference document disagree, the
stable document wins. Promote a new focused RFC instead of silently widening an
old pointer back into a proposal.
