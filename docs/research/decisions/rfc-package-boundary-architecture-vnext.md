# Decision: Package Boundary Architecture VNext

## Metadata

- Decision: Brewva package ownership is governed by honest package identities, single-consumer package folds, explicit provider-core consumption, and a checked runtime subpath registry.
- Date: `2026-05-14`
- Status: accepted
- Stable docs:
  - `docs/architecture/system-architecture.md`
  - `docs/reference/runtime.md`
  - `docs/reference/provider-streaming.md`
  - `docs/reference/extensions.md`
  - `skills/project/shared/package-boundaries.md`
  - `skills/project/shared/source-map.md`
  - `skills/project/shared/anti-patterns.md`
  - `skills/project/shared/runtime-subpaths.json`
- Code anchors:
  - `packages/brewva-ingress-telegram/src/index.ts`
  - `packages/brewva-channels-telegram/src/index.ts`
  - `packages/brewva-tools/src/internal/box/`
  - `packages/brewva-tools/src/contracts/index.ts`
  - `packages/brewva-cli/src/internal/tui/`
  - `packages/brewva-cli/runtime/internal-opentui-runtime.ts`
  - `packages/brewva-cli/runtime/opentui/index.ts`
  - `packages/brewva-gateway/src/channels/bridges/telegram/`
  - `packages/brewva-gateway/src/hosted/internal/provider/execution-port.ts`
  - `packages/brewva-runtime/package.json`
  - `test/fitness/package-boundary-vnext.fitness.test.ts`
  - `test/fitness/provider-core/provider-core-consumption-matrix.fitness.test.ts`
  - `test/fitness/runtime-subpath-registry.fitness.test.ts`

## Decision Summary

- The generic `@brewva/brewva-ingress` package identity is removed. The current webhook ingress implementation is Telegram-specific and is named `@brewva/brewva-ingress-telegram`; no generic ingress package exists until a second channel, second transport, or repeated webhook/auth contract proves the abstraction.
- `@brewva/brewva-box` is folded into `@brewva/brewva-tools` internals because BoxLite execution has one production consumer. Tool-facing BoxLite contracts are exposed only through tools-owned execution surfaces.
- `@brewva/brewva-tui` is folded into `@brewva/brewva-cli` internals because terminal UI primitives and the OpenTUI quarantine have one production consumer. Direct OpenTUI imports remain isolated in CLI runtime adapters.
- `@brewva/brewva-mcp-adapter` remains a protocol translation package. Managed-tool capability policy and hosted action classes stay in tools/gateway composition.
- Gateway may consume concrete Telegram packages only from Telegram bridge modules. Gateway admin/ingress re-export cleanup is deliberately separate and tracked as `gateway-ingress-admin-reexport-audit-2026-07-15`.
- Provider-core consumption is explicit: substrate consumes provider-core contracts only; gateway consumes documented hosted surfaces, with provider-core stream access centralized behind `hosted/internal/provider/execution-port.ts`.
- Runtime package exports are governed by `skills/project/shared/runtime-subpaths.json`. `semantic-artifacts`, `runtime-effect`, and `event-log` are internalized; `evidence` and `patch-history` remain `keep-with-audit` entries with dated review triggers.
- Package descriptions, package-boundary rows, declared-versus-used workspace dependencies, removed package identities, runtime subpath ownership, and provider-core consumption are locked by fitness tests.

## Superseded by

- None.
