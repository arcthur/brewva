# Documentation Index

This repository uses a layered documentation system:

- `guide`: how to use and operate the system
- `architecture`: implemented design, boundaries, and invariants
- `reference`: stable contracts and technical surfaces
- `journeys`: operator entrypoints and cross-package review flows
- `solutions`: repository-native engineering precedents and compound knowledge
- `troubleshooting`: failure patterns and remediation
- `research`: incubating design notes with explicit promotion targets

## Getting Started

- Overview: `docs/guide/overview.md`
- Installation: `docs/guide/installation.md`
- Features: `docs/guide/features.md`
- CLI: `docs/guide/cli.md`
- Gateway daemon: `docs/guide/gateway-control-plane-daemon.md`
- Telegram webhook edge ingress: `docs/guide/telegram-webhook-edge-ingress.md`
- Runtime architecture: `docs/guide/understanding-runtime-system.md`
- Orchestration: `docs/guide/orchestration.md`
- Skill categories: `docs/guide/category-and-skills.md`
- Channel agent workspace: `docs/guide/channel-agent-workspace.md`

## Journeys

- Journeys overview: `docs/journeys/README.md`
- Operator journeys:
  - Interactive session: `docs/journeys/operator/interactive-session.md`
  - Inspect, replay, and recovery: `docs/journeys/operator/inspect-replay-and-recovery.md`
  - Approval and rollback: `docs/journeys/operator/approval-and-rollback.md`
  - Gateway control-plane lifecycle: `docs/journeys/operator/gateway-control-plane-lifecycle.md`
  - Channel gateway and turn flow: `docs/journeys/operator/channel-gateway-and-turn-flow.md`
  - Background and parallelism: `docs/journeys/operator/background-and-parallelism.md`
  - Intent-driven scheduling: `docs/journeys/operator/intent-driven-scheduling.md`
- Internal journeys:
  - Context and compaction: `docs/journeys/internal/context-and-compaction.md`

## Architecture

- System architecture: `docs/architecture/system-architecture.md`
- Design axioms: `docs/architecture/design-axioms.md`
- Exploration and effect governance: `docs/architecture/exploration-and-effect-governance.md`
- Cognitive product architecture: `docs/architecture/cognitive-product-architecture.md`
- Control and data flow: `docs/architecture/control-and-data-flow.md`
- Invariants and reliability: `docs/architecture/invariants-and-reliability.md`

## Reference

- Configuration: `docs/reference/configuration.md`
- Tools: `docs/reference/tools.md`
- Skills: `docs/reference/skills.md`
- Runtime contract and ports: `docs/reference/runtime.md`
- Context composer: `docs/reference/context-composer.md`
- Proactivity (removed, explicit heartbeat remains): `docs/reference/proactivity-engine.md`
- Proposal boundary: `docs/reference/proposal-boundary.md`
- Events: `docs/reference/events.md`
- Runtime plugins: `docs/reference/runtime-plugins.md`
- Commands (CLI surface): `docs/reference/commands.md`
- Gateway control-plane protocol: `docs/reference/gateway-control-plane-protocol.md`
- Session lifecycle: `docs/reference/session-lifecycle.md`
- Budget matrix: `docs/reference/budget-matrix.md`
- Artifacts and paths: `docs/reference/artifacts-and-paths.md`
- Working projection: `docs/reference/working-projection.md`
- Glossary: `docs/reference/glossary.md`
- Known limitations: `docs/reference/limitations.md`

## Troubleshooting

- Troubleshooting: `docs/troubleshooting/common-failures.md`

## Solutions

- Solutions overview: `docs/solutions/README.md`

## Research (Incubation Layer)

- Research playbook: `docs/research/README.md`
- Advisor consultation primitive RFC: `docs/research/rfc-advisor-consultation-primitive-and-specialist-taxonomy-cutover.md`
- Specialist subagents and adversarial verification RFC: `docs/research/rfc-specialist-subagents-and-adversarial-verification.md`
- Architecture doc precision review RFC: `docs/research/rfc-architecture-doc-precision-review.md`
- Boundary-first subtraction and model-native recovery RFC: `docs/research/rfc-boundary-first-subtraction-and-model-native-recovery.md`
- Durability taxonomy RFC: `docs/research/rfc-durability-taxonomy-and-rebuildable-surface-narrowing.md`
- Default-path re-hardening RFC: `docs/research/rfc-default-path-re-hardening-and-advisory-surface-narrowing.md`
- Repository fitness plane and runtime boundary RFC: `docs/research/rfc-repository-fitness-plane-and-runtime-boundary.md`
- Gateway experience-ring decomposition status pointer: `docs/research/rfc-gateway-experience-ring-decomposition.md`
- Roadmap notes: `docs/research/roadmap-notes.md`
- Effect governance RFC: `docs/research/rfc-effect-governance-and-contract-vnext.md`
- Authority-surface narrowing RFC: `docs/research/rfc-authority-surface-narrowing-and-runtime-facade-compression.md`
- Capability compression RFC: `docs/research/rfc-capability-compression-and-output-distillation.md`
- Delegation protocol thinning RFC: `docs/research/rfc-delegation-protocol-thinning-and-replayable-outcomes.md`
- Hosted turn transitions status pointer: `docs/research/rfc-hosted-turn-transitions-and-bounded-recovery.md`
- Subagent delegation RFC: `docs/research/rfc-subagent-delegation-and-isolated-execution.md`
- Pre-parse normalization RFC: `docs/research/rfc-preparse-normalization-model-capability-and-live-audit-split.md`
- Workflow artifacts RFC: `docs/research/rfc-workflow-artifacts-and-posture-control-plane.md`
- Compound Knowledge Plane and Review Ensemble status pointer: `docs/research/rfc-repository-native-compound-knowledge-and-review-ensemble.md`
- Iteration facts RFC: `docs/research/rfc-iteration-facts-and-model-native-optimization-protocols.md`
- Archived / superseded examples: `docs/research/rfc-invocation-spine-and-posture-runtime-vnext.md`, `docs/research/rfc-runtime-decomposition-and-deliberation-thickening.md`

## Source of Truth

- Runtime package: `packages/brewva-runtime/src/index.ts`
- Telegram channel package: `packages/brewva-channels-telegram/src/index.ts`
- Telegram ingress package: `packages/brewva-ingress/src/index.ts`
- Tool package: `packages/brewva-tools/src/index.ts`
- Runtime plugin package: `@brewva/brewva-gateway/runtime-plugins` (`packages/brewva-gateway/src/runtime-plugins/index.ts`)
- CLI package: `packages/brewva-cli/src/index.ts`
- Gateway package: `packages/brewva-gateway/src/index.ts`
- Gateway host subpath: `@brewva/brewva-gateway/host` (`packages/brewva-gateway/src/host.ts`)
- Gateway subagent helpers: `packages/brewva-gateway/src/subagents`
