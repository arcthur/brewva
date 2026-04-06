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
- Active research notes: `docs/research/active/README.md`
- Promoted research notes: `docs/research/promoted/README.md`
- Archived / superseded research notes: `docs/research/archive/README.md`

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
