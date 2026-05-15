# Research Decisions

`docs/research/decisions/` stores accepted, immutable decision records.
Read stable docs first; use this directory only when you need provenance for why a stable contract exists.

Every accepted decision inherits these rules:

- Stable docs and code carry the normative contract; decision records do not duplicate the full specification.
- Future changes update stable docs and start from a new active note when the decision changes materially.
- Generic Why and Non-goals boilerplate is forbidden. Keep only decision-specific non-goals when they preserve a real boundary.
- Deprecated validation tables, surface budgets, implementation checklists, and promoted lifecycle wording stay out of this directory.

## Decision Index

### Runtime Shape And Policy

- [architecture-doc-precision-review](./architecture-doc-precision-review.md)
- [action-policy-registry-and-least-privilege-governance](./action-policy-registry-and-least-privilege-governance.md)
- [authority-surface-narrowing-and-runtime-facade-compression](./authority-surface-narrowing-and-runtime-facade-compression.md)
- [brewva-c2-full-internalization-and-kernel-substrate-boundaries](./brewva-c2-full-internalization-and-kernel-substrate-boundaries.md)
- [boundary-first-subtraction-and-model-native-recovery](./boundary-first-subtraction-and-model-native-recovery.md)
- [boundary-policy-credential-vault-and-loop-guard](./boundary-policy-credential-vault-and-loop-guard.md)
- [brewva-standard-utility-boundary](./brewva-standard-utility-boundary.md)
- [capability-compression-and-output-distillation](./capability-compression-and-output-distillation.md)
- [convention-lifecycle-governance](./convention-lifecycle-governance.md)
- [context-dependency-layering-and-admission-lanes](./context-dependency-layering-and-admission-lanes.md)
- [default-path-re-hardening-and-advisory-surface-narrowing](./default-path-re-hardening-and-advisory-surface-narrowing.md)
- [durability-taxonomy-and-rebuildable-surface-narrowing](./durability-taxonomy-and-rebuildable-surface-narrowing.md)
- [consequence-aware-effect-commitment-model](./consequence-aware-effect-commitment-model.md)
- [effect-native-runtime-foundation](./effect-native-runtime-foundation.md)
- [effect-authority-manifest](./effect-authority-manifest.md)
- [iteration-facts-and-model-native-optimization-protocols](./iteration-facts-and-model-native-optimization-protocols.md)
- [kernel-first-subtraction-and-control-plane-deferral](./kernel-first-subtraction-and-control-plane-deferral.md)
- [model-operated-working-memory-and-context-governance-reset](./model-operated-working-memory-and-context-governance-reset.md)
- [provider-core-domain-slicing-and-driver-port-boundaries](./provider-core-domain-slicing-and-driver-port-boundaries.md)
- [repository-fitness-plane-and-runtime-boundary](./repository-fitness-plane-and-runtime-boundary.md)
- [runtime-domain-admission-and-deletion](./runtime-domain-admission-and-deletion.md)
- [runtime-boundary-subtraction-and-effect-clarity](./runtime-boundary-subtraction-and-effect-clarity.md)
- [runtime-domain-slicing-and-controlled-extension-ports](./runtime-domain-slicing-and-controlled-extension-ports.md)
- [rfc-package-boundary-architecture-vnext](./rfc-package-boundary-architecture-vnext.md)
- [rfc-narrow-and-provable-runtime-boundaries](./rfc-narrow-and-provable-runtime-boundaries.md)
- [runtime-factory-ports](./runtime-factory-ports.md)
- [runtime-public-root-compression](./runtime-public-root-compression.md)
- [skill-first-plugin-and-promotion-governance](./skill-first-plugin-and-promotion-governance.md)
- [stateful-box-plane-and-boxlite-execution-runtime](./stateful-box-plane-and-boxlite-execution-runtime.md)
- [substrate-domain-slicing-and-root-surface-compression](./substrate-domain-slicing-and-root-surface-compression.md)
- [substrate-sdk-diagnostics-and-compaction-mechanism-ports](./substrate-sdk-diagnostics-and-compaction-mechanism-ports.md)
- [substrate-turn-loop-internalization](./substrate-turn-loop-internalization.md)
- [tool-protocol-package-subtraction](./tool-protocol-package-subtraction.md)
- [managed-tool-capability-single-sourcing](./managed-tool-capability-single-sourcing.md)
- [tools-family-slicing-and-capability-contracts](./tools-family-slicing-and-capability-contracts.md)
- [workflow-artifacts-and-posture-control-plane](./workflow-artifacts-and-posture-control-plane.md)

### Delegation, Product, And Knowledge

- [answer-presentation-policy-and-tui-diagram-rendering](./answer-presentation-policy-and-tui-diagram-rendering.md)
- [cli-shell-import-graph-baseline](./cli-shell-import-graph-baseline.md)
- [cli-tui-dual-layer-operator-shell](./cli-tui-dual-layer-operator-shell.md)
- [cli-tui-experience-ring-decomposition-and-shell-port-boundaries](./cli-tui-experience-ring-decomposition-and-shell-port-boundaries.md)
- [inspectable-operator-experience-overlays](./inspectable-operator-experience-overlays.md)
- [kernel-level-reasoning-revert-and-branch-continuity](./kernel-level-reasoning-revert-and-branch-continuity.md)
- [model-native-product-reconstruction-and-closure-vnext](./model-native-product-reconstruction-and-closure-vnext.md)
- [narrative-memory-product-and-bounded-semantic-recall](./narrative-memory-product-and-bounded-semantic-recall.md)
- [opentui-adoption-for-brewva-cli-shell-and-native-boundary](./opentui-adoption-for-brewva-cli-shell-and-native-boundary.md)
- [slash-command-surface-layering-and-control-plane-separation](./slash-command-surface-layering-and-control-plane-separation.md)
- [search-token-policy-and-cjk-tokenizer-boundary](./search-token-policy-and-cjk-tokenizer-boundary.md)
- [session-index-evidence-projection-boundary](./session-index-evidence-projection-boundary.md)
- [recall-source-typed-retrieval-spine](./recall-source-typed-retrieval-spine.md)
- [recall-first-compounding-intelligence-and-experience-products](./recall-first-compounding-intelligence-and-experience-products.md)
- [duckdb-session-query-plane](./duckdb-session-query-plane.md)
- [repository-native-compound-knowledge-and-review-ensemble](./repository-native-compound-knowledge-and-review-ensemble.md)
- [skill-distribution-refresh-and-catalog-surface](./skill-distribution-refresh-and-catalog-surface.md)
- [skill-contract-layering-project-context-and-explicit-activation](./skill-contract-layering-project-context-and-explicit-activation.md)
- [skill-compounding-loop-completeness-and-parameterization-model](./skill-compounding-loop-completeness-and-parameterization-model.md)
- [skill-contract-precision-and-advisory-artifact-boundaries](./skill-contract-precision-and-advisory-artifact-boundaries.md)
- [skill-metadata-as-runtime-contract-and-routing-substrate](./skill-metadata-as-runtime-contract-and-routing-substrate.md)
- [skill-lifecycle-profile-subtraction](./skill-lifecycle-profile-subtraction.md)
- [skill-surface-compression-and-project-guidance-boundaries](./skill-surface-compression-and-project-guidance-boundaries.md)
- [specialist-subagents-and-adversarial-verification](./specialist-subagents-and-adversarial-verification.md)
- [subagent-interface-depth-and-review-ensemble-surface](./subagent-interface-depth-and-review-ensemble-surface.md)
- [subagent-orchestration-v2-role-taxonomy-and-trigger-governance](./subagent-orchestration-v2-role-taxonomy-and-trigger-governance.md)
- [tool-search-advisor-and-auto-broadened-discovery](./tool-search-advisor-and-auto-broadened-discovery.md)

### Gateway, Session, And Scheduling

- [canonical-hosted-turn-envelope](./canonical-hosted-turn-envelope.md)
- [derived-session-wire-schema-and-frontend-session-protocol](./derived-session-wire-schema-and-frontend-session-protocol.md)
- [gateway-domain-slicing-and-control-plane-ports](./gateway-domain-slicing-and-control-plane-ports.md)
- [gateway-experience-ring-decomposition](./gateway-experience-ring-decomposition.md)
- [gateway-hosted-lane-consolidation](./gateway-hosted-lane-consolidation.md)
- [hosted-thread-loop-and-unified-recovery-decisions](./hosted-thread-loop-and-unified-recovery-decisions.md)
- [hosted-context-materialization-ownership](./hosted-context-materialization-ownership.md)
- [hosted-materialization-plan](./hosted-materialization-plan.md)
- [hosted-turn-transitions-and-bounded-recovery](./hosted-turn-transitions-and-bounded-recovery.md)
- [in-flight-steer-control-primitive](./in-flight-steer-control-primitive.md)
- [interactive-prompt-queue-and-pending-strip](./interactive-prompt-queue-and-pending-strip.md)
- [kimi-code-token-cache-adapter](./kimi-code-token-cache-adapter.md)
- [preparse-normalization-model-capability-and-live-audit-split](./preparse-normalization-model-capability-and-live-audit-split.md)
- [preset-based-agent-model-routing](./preset-based-agent-model-routing.md)
- [runtime-owned-session-lifecycle-aggregate-and-authority-gate](./runtime-owned-session-lifecycle-aggregate-and-authority-gate.md)
- [schedule-intent-hardening-and-control-plane-ergonomics](./schedule-intent-hardening-and-control-plane-ergonomics.md)
- [session-lineage-and-context-admission](./session-lineage-and-context-admission.md)
- [session-rewind-as-conversation-fork-primitive](./session-rewind-as-conversation-fork-primitive.md)
- [token-cache-fidelity-and-provider-prefix-stability](./token-cache-fidelity-and-provider-prefix-stability.md)
- [typebox-derived-provider-streaming-parse-boundary](./typebox-derived-provider-streaming-parse-boundary.md)
- [turn-lifecycle-spine](./turn-lifecycle-spine.md)

### Projection And Tool Proofs

- [managed-tool-capability-proof](./managed-tool-capability-proof.md)
- [projection-admission](./projection-admission.md)

## Maintenance Rule

Accepted decisions are not reopened in place. Add only a `Superseded by` link when a new accepted decision replaces one.
