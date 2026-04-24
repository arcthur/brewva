---
strength: lookup
scope: source-map
---

# Brewva Source Map

## Runtime

- Runtime API and contracts: `packages/brewva-runtime/src/runtime.ts`, `packages/brewva-runtime/src/contracts/index.ts`
- Runtime config and semantics: `packages/brewva-runtime/src/config/defaults.ts`, `packages/brewva-runtime/src/config/normalize.ts`, `packages/brewva-runtime/src/security/mode.ts`, `packages/brewva-runtime/src/services/event-pipeline.ts`
- Runtime context and durability: `packages/brewva-runtime/src/context/arena.ts`, `packages/brewva-runtime/src/context/injection-orchestrator.ts`, `packages/brewva-runtime/src/services/context*.ts`, `packages/brewva-runtime/src/channels/recovery-wal*.ts`, `packages/brewva-runtime/src/governance/port.ts`
- Runtime authorization, rollback, and diagnostics: `packages/brewva-runtime/src/services/tool-gate.ts`, `packages/brewva-runtime/src/services/effect-commitment-desk.ts`, `packages/brewva-runtime/src/services/reversible-mutation.ts`, `packages/brewva-runtime/src/services/mutation-rollback.ts`, `packages/brewva-runtime/src/services/task-watchdog.ts`

## Recall and Session Query Plane

- Session index package: `packages/brewva-session-index/src/index.ts`
- Recall broker integration: `packages/brewva-recall/src/broker.ts`, `packages/brewva-recall/src/context-provider.ts`
- CLI insights integration: `packages/brewva-cli/src/insights.ts`
- Distribution/native asset checks: `script/verify-dist.ts`, `script/build-binaries.ts`

## Managed Tools and Entrypoints

- Managed-tool capability boundaries: `packages/brewva-tools/src/runtime-capability-scope.ts`, `packages/brewva-tools/src/managed-tool-metadata-registry.ts`, `packages/brewva-tools/src/utils/runtime-bound-tool.ts`
- Package entrypoints: `packages/brewva-search/src/index.ts`, `packages/brewva-substrate/src/index.ts`, `packages/brewva-agent-engine/src/index.ts`, `packages/brewva-provider-core/src/index.ts`, `packages/brewva-session-index/src/index.ts`, `packages/brewva-recall/src/index.ts`, `packages/brewva-deliberation/src/index.ts`, `packages/brewva-skill-broker/src/index.ts`, `packages/brewva-tools/src/index.ts`, `packages/brewva-gateway/src/runtime-plugins/index.ts`, `packages/brewva-gateway/src/channels/host.ts`, `packages/brewva-gateway/src/host/create-hosted-session.ts`, `packages/brewva-gateway/src/subagents`, `packages/brewva-ingress/src/index.ts`, `packages/brewva-cli/src/index.ts`, `packages/brewva-gateway/src`
- Verification and release tooling: `script/verify-dist.ts`, `script/build-binaries.ts`, `distribution/worker`, `.github/workflows/ci.yml`
- Reference docs: `docs/index.md`, `docs/architecture/system-architecture.md`, `docs/reference/runtime.md`, `docs/reference/proposal-boundary.md`, `docs/reference/events.md`, `docs/reference/*.md`, `docs/research/README.md`, `docs/solutions/README.md`
