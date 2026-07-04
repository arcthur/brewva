# Documentation Index

This repository uses a layered documentation system:

- `guide`: how to use and operate the system
- `architecture`: implemented design, boundaries, and invariants
- `reference`: stable contracts and technical surfaces
- `journeys`: operator entrypoints and cross-package review flows
- `solutions`: repository-native engineering precedents and compound knowledge
- `troubleshooting`: failure patterns and remediation
- `research`: active design notes, accepted decisions, and historical archive

## How To Navigate

- Use `guide` when you want operator-facing setup, deployment, or conceptual
  orientation.
- Use `reference` when you need stable contracts. Generated segments inside
  reference pages carry exact inventories for tools, skills, runtime methods,
  CLI flags, event types, and config keys.
- Use `architecture` when you need implemented boundaries, invariants, or
  rationale.
- Use `journeys` when you want step-by-step operator flows across multiple
  packages or surfaces.
- Use `troubleshooting` when you are diagnosing a concrete failure and need the
  fastest operator entrypoint first.
- Use `solutions` when you want repository-specific engineering precedent or
  proof of what worked before.
- Use `research` when a design is still incubating or you need accepted
  decision provenance after stable docs absorbed the contract.

## Getting Started

Operator and deployment entrypoints:

- Overview: `docs/guide/overview.md`
- Installation: `docs/guide/installation.md`
- CLI: `docs/guide/cli.md`
- Operator conventions: `docs/guide/operator-conventions.md`
- Gateway daemon: `docs/guide/gateway-control-plane-daemon.md`
- Telegram webhook edge ingress: `docs/guide/telegram-webhook-edge-ingress.md`
- Channel agent workspace: `docs/guide/channel-agent-workspace.md`

Conceptual orientation:

- Features: `docs/guide/features.md`
- Runtime system concepts: `docs/guide/understanding-runtime-system.md`
- Hosted orchestration concepts: `docs/guide/orchestration.md`
- Skill categories and routing: `docs/guide/category-and-skills.md`

Workflow walkthroughs:

- Journeys overview: `docs/journeys/README.md`

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
  - MCP tool integration: `docs/journeys/operator/mcp-tool-integration.md`
  - ACP client ingress: `docs/journeys/operator/acp-client-ingress.md`
  - Skill routing and activation: `docs/journeys/operator/skill-routing-and-activation.md`
  - Recall and knowledge compounding: `docs/journeys/operator/recall-and-knowledge-compounding.md`
- Internal journeys:
  - Context and compaction: `docs/journeys/internal/context-and-compaction.md`
  - WAL and crash recovery: `docs/journeys/internal/wal-and-crash-recovery.md`
  - Provider turn, streaming, and fallback: `docs/journeys/internal/provider-turn-streaming-and-fallback.md`
  - Hosted behavior installation: `docs/journeys/internal/hosted-behavior-installation.md`

## Architecture

- System architecture: `docs/architecture/system-architecture.md`
- Design axioms: `docs/architecture/design-axioms.md`
- Exploration and effect governance: `docs/architecture/exploration-and-effect-governance.md`
- Cognitive product architecture: `docs/architecture/cognitive-product-architecture.md`
- Control and data flow: `docs/architecture/control-and-data-flow.md`
- Invariants and reliability: `docs/architecture/invariants-and-reliability.md`

## Reference

- Configuration: `docs/reference/configuration.md`
- MCP integration: `docs/reference/mcp-integration.md`
- Tools: `docs/reference/tools.md`
  - Navigation tools: `docs/reference/tools/navigation.md`
  - Execution tools: `docs/reference/tools/execution.md`
  - Memory and recall tools: `docs/reference/tools/memory-and-recall.md`
  - Delegation tools: `docs/reference/tools/delegation.md`
  - Workflow and scheduling tools: `docs/reference/tools/workflow-and-scheduling.md`
- Skills: `docs/reference/skills.md`
- Skill routing and capability selection: `docs/reference/skill-routing.md`
- Skill navigation (generated handoff graph): `docs/reference/skill-navigation.md`
- Axiom enforcement (generated negative-space view): `docs/reference/axiom-enforcement.md`
- Runtime contract and ports: `docs/reference/runtime.md`
- Provider streaming: `docs/reference/provider-streaming.md`
- Hosted dynamic context: `docs/reference/hosted-dynamic-context.md`
- Token cache: `docs/reference/token-cache.md`
- Proactivity (removed, explicit heartbeat remains): `docs/reference/proactivity-engine.md`
- Proposal boundary: `docs/reference/proposal-boundary.md`
- Events: `docs/reference/events/README.md`
  - Runtime event families: `docs/reference/events/runtime.md`
  - Session event families: `docs/reference/events/session.md`
  - Tool event families: `docs/reference/events/tools.md`
  - Skill and memory event families: `docs/reference/events/skills-and-memory.md`
  - Worker event families: `docs/reference/events/workers.md`
- Runtime plugins: `docs/reference/extensions.md`
- Commands: `docs/reference/commands.md`
  - Interactive shell: `docs/reference/commands/interactive.md`
  - Gateway commands: `docs/reference/commands/gateway.md`
  - Credentials, inspect, and insights: `docs/reference/commands/credentials-inspect-insights.md`
  - Channel commands: `docs/reference/commands/channel.md`
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

## Research

- Research playbook: `docs/research/README.md`
- Active research notes: `docs/research/active/README.md`
- Accepted decisions: `docs/research/decisions/README.md`
- Archived / superseded research notes: `docs/research/archive/README.md`

## Source of Truth

- Runtime package: `packages/brewva-runtime/src/index.ts`
- Telegram channel package: `packages/brewva-channels-telegram/src/index.ts`
- Telegram ingress package: `packages/brewva-ingress-telegram/src/index.ts`
- Tool package: `packages/brewva-tools/src/index.ts`
- Runtime plugin package: `@brewva/brewva-gateway/extensions` (`packages/brewva-gateway/src/hosted/internal/session/host-api-installation.ts`)
- CLI package: `packages/brewva-cli/src/index.ts`
- Gateway package: `packages/brewva-gateway/src/index.ts`
- Gateway host subpath: `@brewva/brewva-gateway/hosted` (`packages/brewva-gateway/src/hosted/api.ts`)
- Gateway delegation helpers: `packages/brewva-gateway/src/delegation`
