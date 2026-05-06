---
strength: lookup
scope: source-map
---

# Brewva Source Map

## Runtime

- Runtime API and contracts: `packages/brewva-runtime/src/runtime/runtime.ts`, `packages/brewva-runtime/src/public/index.ts`
- Runtime config and semantics: `packages/brewva-runtime/src/config/defaults.ts`, `packages/brewva-runtime/src/config/normalize.ts`, `packages/brewva-runtime/src/security/mode.ts`, `packages/brewva-runtime/src/domain/sessions/event-pipeline.ts`
- Runtime context and durability: `packages/brewva-runtime/src/domain/context/arena.ts`, `packages/brewva-runtime/src/domain/context/injection-orchestrator.ts`, `packages/brewva-runtime/src/domain/context/context-compaction.ts`, `packages/brewva-runtime/src/domain/context/context-pressure.ts`, `packages/brewva-runtime/src/domain/context/context-supplemental-budget.ts`, `packages/brewva-runtime/src/channels/recovery-wal*.ts`, `packages/brewva-runtime/src/governance/port.ts`
- Runtime authorization, rollback, and diagnostics: `packages/brewva-runtime/src/domain/tools/tool-gate.ts`, `packages/brewva-runtime/src/domain/proposals/effect-commitment-desk.ts`, `packages/brewva-runtime/src/domain/governance/reversible-mutation.ts`, `packages/brewva-runtime/src/domain/governance/mutation-rollback.ts`, `packages/brewva-runtime/src/domain/task/task-watchdog.ts`

## Recall and Session Query Plane

- Search package: `packages/brewva-search/src/index.ts`, `packages/brewva-search/src/public/index.ts`, `packages/brewva-search/src/normalization.ts`, `packages/brewva-search/src/tokenization/tokenizer.ts`, `packages/brewva-search/src/jieba/wasm.ts`
- Session index package: `packages/brewva-session-index/src/index.ts`, `packages/brewva-session-index/src/public/index.ts`, `packages/brewva-session-index/src/api.ts`, `packages/brewva-session-index/src/factory.ts`, `packages/brewva-session-index/src/evidence/index.ts`, `packages/brewva-session-index/src/evidence/tokens.ts`, `packages/brewva-session-index/src/query/digests.ts`, `packages/brewva-session-index/src/query/tape-evidence.ts`, `packages/brewva-session-index/src/projection/session.ts`, `packages/brewva-session-index/src/duckdb/lifecycle.ts`
- Recall broker integration: `packages/brewva-recall/src/public/index.ts`, `packages/brewva-recall/src/broker/index.ts`, `packages/brewva-recall/src/broker/broker.ts`, `packages/brewva-recall/src/broker/tape-evidence.ts`, `packages/brewva-recall/src/context/provider.ts`, `packages/brewva-recall/src/knowledge/search.ts`, `packages/brewva-recall/src/evidence/classification.ts`
- CLI insights integration: `packages/brewva-cli/src/insights.ts`
- Distribution/native asset checks: `script/verify-dist.ts`, `script/build-binaries.ts`

## Managed Tools and Entrypoints

- Managed-tool capability boundaries: `packages/brewva-tools/src/runtime-capability-scope.ts`, `packages/brewva-tools/src/managed-tool-metadata-registry.ts`, `packages/brewva-tools/src/utils/runtime-bound-tool.ts`
- Package entrypoints: `packages/brewva-search/src/index.ts`, `packages/brewva-search/src/public/index.ts`, `packages/brewva-substrate/src/public/index.ts`, `packages/brewva-substrate/src/contracts/index.ts`, `packages/brewva-substrate/src/session/index.ts`, `packages/brewva-substrate/src/prompt/index.ts`, `packages/brewva-substrate/src/resources/index.ts`, `packages/brewva-substrate/src/provenance/index.ts`, `packages/brewva-substrate/src/execution/index.ts`, `packages/brewva-substrate/src/compaction/index.ts`, `packages/brewva-substrate/src/tools/index.ts`, `packages/brewva-substrate/src/host-api/index.ts`, `packages/brewva-substrate/src/persistence/index.ts`, `packages/brewva-substrate/src/provider/index.ts`, `packages/brewva-substrate/src/turn/index.ts`, `packages/brewva-substrate/src/sdk/index.ts`, `packages/brewva-provider-core/src/index.ts`, `packages/brewva-session-index/src/index.ts`, `packages/brewva-session-index/src/public/index.ts`, `packages/brewva-recall/src/index.ts`, `packages/brewva-recall/src/public/index.ts`, `packages/brewva-recall/src/broker/index.ts`, `packages/brewva-recall/src/context/index.ts`, `packages/brewva-recall/src/knowledge/index.ts`, `packages/brewva-recall/src/evidence/index.ts`, `packages/brewva-deliberation/src/index.ts`, `packages/brewva-skill-broker/src/index.ts`, `packages/brewva-tools/src/index.ts`, `packages/brewva-gateway/src/runtime-plugins/index.ts`, `packages/brewva-gateway/src/channels/host.ts`, `packages/brewva-gateway/src/host/create-hosted-session.ts`, `packages/brewva-gateway/src/subagents`, `packages/brewva-ingress/src/index.ts`, `packages/brewva-cli/src/index.ts`, `packages/brewva-gateway/src`
- Verification and release tooling: `script/verify-dist.ts`, `script/build-binaries.ts`, `distribution/worker`, `.github/workflows/ci.yml`
- Reference docs: `docs/index.md`, `docs/architecture/system-architecture.md`, `docs/reference/runtime.md`, `docs/reference/proposal-boundary.md`, `docs/reference/events.md`, `docs/reference/*.md`, `docs/research/README.md`, `docs/solutions/README.md`
