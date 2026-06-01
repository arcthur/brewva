---
strength: lookup
scope: source-map
convention_kind: project_fact
retirement_sensitivity: auto_decay_allowed
---

# Brewva Source Map

## Runtime

- Runtime API and contracts: `packages/brewva-runtime/src/runtime/runtime.ts`, `packages/brewva-runtime/src/public/index.ts`
- Runtime subpath ownership registry: `skills/project/shared/runtime-subpaths.json`, enforced by `test/fitness/runtime-subpath-registry.fitness.test.ts`
- Runtime config and semantics: `packages/brewva-runtime/src/config/defaults.ts`, `packages/brewva-runtime/src/config/normalize.ts`, `packages/brewva-runtime/src/security/mode.ts`, `packages/brewva-runtime/src/runtime/config/state.ts`
- Runtime tape and durability: `packages/brewva-runtime/src/runtime/tape/impl.ts`, `packages/brewva-runtime/src/runtime/runtime-api.ts`
- Runtime model attention: `packages/brewva-runtime/src/runtime/model/impl.ts`
- Runtime authorization and tool commitments: `packages/brewva-runtime/src/runtime/kernel/impl.ts`, `packages/brewva-runtime/src/runtime/kernel/policy/tool-admission-policy.ts`, `packages/brewva-runtime/src/runtime/kernel/policy/tool-decision.ts`
- Runtime verification gate policy input: `packages/brewva-runtime/src/runtime/kernel/impl.ts`, `packages/brewva-runtime/src/runtime/kernel/port.ts`

## Product Projection and Advisory Surfaces

- Work Card inspect projection: `packages/brewva-cli/src/operator/inspect/work-card.ts`
- Shell, CLI, and channel inspect consumers: `packages/brewva-cli/src/operator/inspect/work-card.ts`, `packages/brewva-cli/src/commands/inspect.ts`, `packages/brewva-gateway/src/channels/control-router.ts`
- Attention Options tool family: `packages/brewva-tools/src/families/memory/attention-options.ts`, `packages/brewva-tools/src/runtime-port/four-port/iteration-facts.ts`
- Continuation-anchor command and tape bridge: `packages/brewva-cli/src/shell/commands/shell-command-registry.ts`, `packages/brewva-cli/src/runtime/cli-runtime-tape.ts`
- Hosted latest continuation-anchor context: `packages/brewva-gateway/src/hosted/internal/context/workbench-context.ts`
- Advisory extension and verification gate manifests: `packages/brewva-gateway/src/extensions/api.ts`
- Runtime turn verification gate bridge: `packages/brewva-gateway/src/hosted/internal/turn-adapter/runtime-turn-verification-gates.ts`

## Recall and Session Query Plane

- Search package: `packages/brewva-search/src/index.ts`, `packages/brewva-search/src/public/index.ts`, `packages/brewva-search/src/normalization.ts`, `packages/brewva-search/src/tokenization/tokenizer.ts`, `packages/brewva-search/src/jieba/wasm.ts`
- Session index package: `packages/brewva-session-index/src/index.ts`, `packages/brewva-session-index/src/public/index.ts`, `packages/brewva-session-index/src/api.ts`, `packages/brewva-session-index/src/factory.ts`, `packages/brewva-session-index/src/evidence/index.ts`, `packages/brewva-session-index/src/evidence/tokens.ts`, `packages/brewva-session-index/src/query/digests.ts`, `packages/brewva-session-index/src/query/tape-evidence.ts`, `packages/brewva-session-index/src/projection/session.ts`, `packages/brewva-session-index/src/duckdb/lifecycle.ts`
- Recall broker integration: `packages/brewva-recall/src/public/index.ts`, `packages/brewva-recall/src/broker/index.ts`, `packages/brewva-recall/src/broker/broker.ts`, `packages/brewva-recall/src/broker/tape-evidence.ts`, `packages/brewva-recall/src/broker/ranking.ts`, `packages/brewva-recall/src/knowledge/search.ts`, `packages/brewva-recall/src/evidence/classification.ts`
- CLI insights integration: `packages/brewva-cli/src/insights.ts`
- Distribution/native asset checks: `script/verify-dist.ts`, `script/build-binaries.ts`

## Standard Utilities

- Standard utility package: `packages/brewva-std/package.json`, `packages/brewva-std/src/async.ts`, `packages/brewva-std/src/collections.ts`, `packages/brewva-std/src/hash.ts`, `packages/brewva-std/src/json.ts`, `packages/brewva-std/src/markdown.ts`, `packages/brewva-std/src/node/fs.ts`, `packages/brewva-std/src/text.ts`, `packages/brewva-std/src/unknown.ts`
- Standard utility boundary tests: `test/fitness/std-boundary.fitness.test.ts`, `test/unit/std`

## Managed Tools and Entrypoints

- Managed-tool capability boundaries: `packages/brewva-tools/src/registry/capability-scope.ts`, `packages/brewva-tools/src/registry/managed-metadata.ts`, `packages/brewva-tools/src/registry/runtime-bound-tool.ts`
- Tools package entrypoints: `packages/brewva-tools/src/index.ts`, `packages/brewva-tools/src/contracts/index.ts`, `packages/brewva-tools/src/registry/index.ts`, `packages/brewva-tools/src/runtime-port/index.ts`, `packages/brewva-tools/src/families/navigation/api.ts`, `packages/brewva-tools/src/families/execution/api.ts`, `packages/brewva-tools/src/families/memory/api.ts`, `packages/brewva-tools/src/families/delegation/api.ts`, `packages/brewva-tools/src/families/workflow/api.ts`
- Source patch and real LSP: `packages/brewva-tools/src/families/navigation/source-patch.ts`, `packages/brewva-tools/src/internal/source-patch-gate.ts`, `packages/brewva-tools/src/families/navigation/lsp.ts`, `packages/brewva-tools/src/families/navigation/lsp-server/client.ts`, `packages/brewva-tools/src/families/navigation/lsp-server/manager.ts`, `@brewva/brewva-vocabulary/workbench`
- Resource URI routing: `packages/brewva-substrate/src/resources/resource-loader.ts`, `packages/brewva-substrate/src/resources/resource-router.ts`, `packages/brewva-substrate/src/resources/resource-types.ts`
- Source intelligence: `packages/brewva-tools/src/families/navigation/source-intelligence/engine.ts`, `packages/brewva-tools/src/families/navigation/source-intelligence/ir.ts`, `packages/brewva-tools/src/families/navigation/source-intelligence/tools.ts`, `packages/brewva-tools/src/families/navigation/source-intelligence/adapters`, `packages/brewva-tools/src/families/navigation/source-intelligence/graph`, `packages/brewva-tools/src/families/navigation/source-intelligence/grammars/manifest.json`
- Internal BoxLite execution plane: `packages/brewva-tools/src/internal/box/index.ts`, `packages/brewva-tools/src/internal/box/boxlite/plane.ts`, `packages/brewva-tools/src/families/execution/box-plane-runtime.ts`
- CLI-internal terminal UI and OpenTUI runtime: `packages/brewva-cli/src/internal/tui/index.ts`, `packages/brewva-cli/src/internal/tui/internal-opentui-runtime.ts`, `packages/brewva-cli/runtime/internal-opentui-runtime.ts`, `packages/brewva-cli/runtime/opentui/index.ts`
- Package entrypoints: `packages/brewva-search/src/index.ts`, `packages/brewva-search/src/public/index.ts`, `packages/brewva-std/package.json`, `packages/brewva-effect/src/index.ts`, `packages/brewva-token-estimation/src/index.ts`, `packages/brewva-substrate/src/public/index.ts`, `packages/brewva-substrate/src/contracts/index.ts`, `packages/brewva-substrate/src/session/index.ts`, `packages/brewva-substrate/src/prompt/index.ts`, `packages/brewva-substrate/src/resources/index.ts`, `packages/brewva-substrate/src/provenance/index.ts`, `packages/brewva-substrate/src/execution/index.ts`, `packages/brewva-substrate/src/compaction/index.ts`, `packages/brewva-substrate/src/tools/index.ts`, `packages/brewva-substrate/src/host-api/index.ts`, `packages/brewva-substrate/src/persistence/index.ts`, `packages/brewva-substrate/src/provider/index.ts`, `packages/brewva-substrate/src/agent-protocol/index.ts`, `packages/brewva-substrate/src/sdk/index.ts`, `packages/brewva-provider-core/src/index.ts`, `packages/brewva-mcp-adapter/src/index.ts`, `packages/brewva-session-index/src/index.ts`, `packages/brewva-session-index/src/public/index.ts`, `packages/brewva-recall/src/index.ts`, `packages/brewva-recall/src/public/index.ts`, `packages/brewva-recall/src/broker/index.ts`, `packages/brewva-recall/src/knowledge/index.ts`, `packages/brewva-recall/src/evidence/index.ts`, `packages/brewva-channels-telegram/src/index.ts`, `packages/brewva-ingress-telegram/src/index.ts`, `packages/brewva-gateway/src/admin/api.ts`, `packages/brewva-gateway/src/hosted/api.ts`, `packages/brewva-gateway/src/extensions/api.ts`, `packages/brewva-gateway/src/channels/host.ts`, `packages/brewva-gateway/src/delegation`, `packages/brewva-cli/src/index.ts`, `packages/brewva-gateway/src`
- Verification and release tooling: `script/verify-dist.ts`, `script/build-binaries.ts`, `distribution/worker`, `.github/workflows/ci.yml`
- Reference docs: `docs/index.md`, `docs/architecture/system-architecture.md`, `docs/reference/runtime.md`, `docs/reference/proposal-boundary.md`, `docs/reference/events.md`, `docs/reference/*.md`, `docs/research/README.md`, `docs/solutions/README.md`

## Boundary Fitness Tests

- Package boundary vnext gate: `test/fitness/package-boundary-vnext.fitness.test.ts` verifies package descriptions, boundary rows, declared-versus-used workspace dependencies, graph cycles, removed package identities, Telegram bridge isolation, and `AGENTS.md` primary surfaces.
- Provider-core consumption matrix: `test/fitness/provider-core/provider-core-consumption-matrix.fitness.test.ts` keeps gateway and substrate on documented provider-core subpaths.
- Runtime subpath registry: `test/fitness/runtime-subpath-registry.fitness.test.ts` compares `packages/brewva-runtime/package.json` exports with `skills/project/shared/runtime-subpaths.json`.
- CLI OpenTUI quarantine: `test/fitness/cli/opentui-import-quarantine.fitness.test.ts` and `test/fitness/cli/tui-internal-runtime.fitness.test.ts` keep direct OpenTUI imports inside CLI runtime adapters.
- Runtime promoted architecture: `test/fitness/runtime-promoted-architecture.fitness.test.ts` keeps the runtime root narrow and domain subpaths admitted through semantic API surfaces.
- Gateway hosted-session surface: `test/fitness/gateway/hosted-session-surface.fitness.test.ts` keeps hosted session/provider seams on explicit internal ports.

## Gateway

- Control-plane/admin seam: `packages/brewva-gateway/src/admin/api.ts`, `packages/brewva-gateway/src/admin/internal/cli.ts`, `packages/brewva-gateway/src/ingress/api.ts`, `packages/brewva-gateway/src/ingress/wiring.ts`
- Hosted provider seam: `packages/brewva-gateway/src/hosted/internal/provider/connection-types.ts`, `packages/brewva-gateway/src/hosted/internal/provider/types.ts`, `packages/brewva-gateway/src/hosted/internal/provider/connection-port.ts`, `packages/brewva-gateway/src/hosted/internal/provider/execution-port.ts`
- Hosted context and compaction policy: `packages/brewva-gateway/src/hosted/internal/context/materialization.ts`, `packages/brewva-gateway/src/hosted/internal/compaction/model-downshift-policy.ts`
- Hosted extension seam: `packages/brewva-gateway/src/extensions/api.ts`, `packages/brewva-gateway/src/hosted/internal/session/host-api-installation.ts`
- Shared gateway utilities: `packages/brewva-gateway/src/utils/async.ts`, `packages/brewva-gateway/src/utils/errors.ts`, `packages/brewva-gateway/src/utils/runtime.ts`, `packages/brewva-gateway/src/utils/ws.ts`
