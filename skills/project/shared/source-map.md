---
strength: lookup
scope: source-map
convention_kind: project_fact
retirement_sensitivity: auto_decay_allowed
---

# Brewva Source Map

## Runtime

- Runtime API and contracts: `packages/brewva-runtime/src/runtime/runtime.ts`, `packages/brewva-runtime/src/public/index.ts`
- Runtime config and semantics: `packages/brewva-runtime/src/config/defaults.ts`, `packages/brewva-runtime/src/config/normalize.ts`, `packages/brewva-runtime/src/security/mode.ts`, `packages/brewva-runtime/src/domain/sessions/event-pipeline.ts`
- Runtime context and durability: `packages/brewva-runtime/src/domain/context/context.ts`, `packages/brewva-runtime/src/domain/context/context-compaction.ts`, `packages/brewva-runtime/src/domain/context/context-pressure.ts`, `packages/brewva-runtime/src/domain/context/history-view-baseline.ts`, `packages/brewva-runtime/src/domain/context/runtime-status.ts`, `packages/brewva-runtime/src/domain/context/types.ts`
- Runtime workbench: `packages/brewva-runtime/src/domain/workbench/service.ts`, `packages/brewva-runtime/src/domain/workbench/runtime-surface.ts`, `packages/brewva-runtime/src/domain/workbench/api.ts`
- Runtime authorization, proposals, rollback, and diagnostics: `packages/brewva-runtime/src/domain/tools/tool-gate.ts`, `packages/brewva-runtime/src/domain/proposals/effect-commitment-desk.ts`, `packages/brewva-runtime/src/domain/governance/action-policy.ts`, `packages/brewva-runtime/src/domain/patching/file-change.ts`, `packages/brewva-runtime/src/domain/task/task.ts`

## Recall and Session Query Plane

- Search package: `packages/brewva-search/src/index.ts`, `packages/brewva-search/src/public/index.ts`, `packages/brewva-search/src/normalization.ts`, `packages/brewva-search/src/tokenization/tokenizer.ts`, `packages/brewva-search/src/jieba/wasm.ts`
- Session index package: `packages/brewva-session-index/src/index.ts`, `packages/brewva-session-index/src/public/index.ts`, `packages/brewva-session-index/src/api.ts`, `packages/brewva-session-index/src/factory.ts`, `packages/brewva-session-index/src/evidence/index.ts`, `packages/brewva-session-index/src/evidence/tokens.ts`, `packages/brewva-session-index/src/query/digests.ts`, `packages/brewva-session-index/src/query/tape-evidence.ts`, `packages/brewva-session-index/src/projection/session.ts`, `packages/brewva-session-index/src/duckdb/lifecycle.ts`
- Recall broker integration: `packages/brewva-recall/src/public/index.ts`, `packages/brewva-recall/src/broker/index.ts`, `packages/brewva-recall/src/broker/broker.ts`, `packages/brewva-recall/src/broker/tape-evidence.ts`, `packages/brewva-recall/src/broker/ranking.ts`, `packages/brewva-recall/src/knowledge/search.ts`, `packages/brewva-recall/src/evidence/classification.ts`
- CLI insights integration: `packages/brewva-cli/src/insights.ts`
- Distribution/native asset checks: `script/verify-dist.ts`, `script/build-binaries.ts`

## Standard Utilities

- Standard utility package: `packages/brewva-std/package.json`, `packages/brewva-std/src/async.ts`, `packages/brewva-std/src/collections.ts`, `packages/brewva-std/src/hash.ts`, `packages/brewva-std/src/json.ts`, `packages/brewva-std/src/markdown.ts`, `packages/brewva-std/src/node/fs.ts`, `packages/brewva-std/src/text.ts`, `packages/brewva-std/src/unknown.ts`
- Standard utility boundary tests: `test/quality/std-boundary.quality.test.ts`, `test/unit/std`

## Managed Tools and Entrypoints

- Managed-tool capability boundaries: `packages/brewva-tools/src/registry/capability-scope.ts`, `packages/brewva-tools/src/registry/managed-metadata.ts`, `packages/brewva-tools/src/registry/runtime-bound-tool.ts`
- Tools package entrypoints: `packages/brewva-tools/src/index.ts`, `packages/brewva-tools/src/contracts/index.ts`, `packages/brewva-tools/src/registry/index.ts`, `packages/brewva-tools/src/runtime-port/index.ts`, `packages/brewva-tools/src/families/navigation/api.ts`, `packages/brewva-tools/src/families/execution/api.ts`, `packages/brewva-tools/src/families/memory/api.ts`, `packages/brewva-tools/src/families/delegation/api.ts`, `packages/brewva-tools/src/families/workflow/api.ts`
- Package entrypoints: `packages/brewva-search/src/index.ts`, `packages/brewva-search/src/public/index.ts`, `packages/brewva-std/package.json`, `packages/brewva-substrate/src/public/index.ts`, `packages/brewva-substrate/src/contracts/index.ts`, `packages/brewva-substrate/src/session/index.ts`, `packages/brewva-substrate/src/prompt/index.ts`, `packages/brewva-substrate/src/resources/index.ts`, `packages/brewva-substrate/src/provenance/index.ts`, `packages/brewva-substrate/src/execution/index.ts`, `packages/brewva-substrate/src/compaction/index.ts`, `packages/brewva-substrate/src/tools/index.ts`, `packages/brewva-substrate/src/host-api/index.ts`, `packages/brewva-substrate/src/persistence/index.ts`, `packages/brewva-substrate/src/provider/index.ts`, `packages/brewva-substrate/src/turn/index.ts`, `packages/brewva-substrate/src/sdk/index.ts`, `packages/brewva-provider-core/src/index.ts`, `packages/brewva-session-index/src/index.ts`, `packages/brewva-session-index/src/public/index.ts`, `packages/brewva-recall/src/index.ts`, `packages/brewva-recall/src/public/index.ts`, `packages/brewva-recall/src/broker/index.ts`, `packages/brewva-recall/src/knowledge/index.ts`, `packages/brewva-recall/src/evidence/index.ts`, `packages/brewva-gateway/src/admin/api.ts`, `packages/brewva-gateway/src/hosted/api.ts`, `packages/brewva-gateway/src/extensions/api.ts`, `packages/brewva-gateway/src/channels/host.ts`, `packages/brewva-gateway/src/delegation`, `packages/brewva-cli/src/index.ts`, `packages/brewva-gateway/src`
- Verification and release tooling: `script/verify-dist.ts`, `script/build-binaries.ts`, `distribution/worker`, `.github/workflows/ci.yml`
- Reference docs: `docs/index.md`, `docs/architecture/system-architecture.md`, `docs/reference/runtime.md`, `docs/reference/proposal-boundary.md`, `docs/reference/events.md`, `docs/reference/*.md`, `docs/research/README.md`, `docs/solutions/README.md`

## Gateway

- Control-plane/admin seam: `packages/brewva-gateway/src/admin/api.ts`, `packages/brewva-gateway/src/admin/internal/cli.ts`, `packages/brewva-gateway/src/ingress/api.ts`, `packages/brewva-gateway/src/ingress/wiring.ts`
- Hosted provider seam: `packages/brewva-gateway/src/hosted/internal/provider/connection-types.ts`, `packages/brewva-gateway/src/hosted/internal/provider/types.ts`, `packages/brewva-gateway/src/hosted/internal/provider/connection-port.ts`
- Hosted extension seam: `packages/brewva-gateway/src/extensions/api.ts`, `packages/brewva-gateway/src/hosted/internal/session/host-api-installation.ts`
- Shared gateway utilities: `packages/brewva-gateway/src/utils/async.ts`, `packages/brewva-gateway/src/utils/errors.ts`, `packages/brewva-gateway/src/utils/runtime.ts`, `packages/brewva-gateway/src/utils/ws.ts`
