# Overview

`Brewva` is an AI-native coding agent runtime built with Bun and TypeScript,
organized as a monorepo with explicit package boundaries.
This page is an orientation map, not the exhaustive package or contract
reference.

## Package Boundaries

- Runtime core: `packages/brewva-runtime/src/runtime/runtime.ts`
- Telegram channel adapter: `packages/brewva-channels-telegram/src/index.ts`
- Ingress adapters: `packages/brewva-ingress-telegram/src/index.ts`
- Gateway control plane: `packages/brewva-gateway/src/index.ts`
- Tool registry: `packages/brewva-tools/src/index.ts`
- Model-operated workbench state: `packages/brewva-gateway/src/hosted/internal/context/workbench-context.ts`
- Runtime model port: `packages/brewva-runtime/src/runtime/model/impl.ts`
- Legacy skill catalog contracts: `packages/brewva-runtime/src/runtime/model`
- Extension wiring: `@brewva/brewva-gateway/extensions` (`packages/brewva-gateway/src/hosted/internal/session/host-api-installation.ts`)
- CLI entrypoint: `packages/brewva-cli/src/index.ts`

## Runtime Responsibilities

- Skill catalog discovery and refresh
- Evidence ledger recording, digest generation, and query
- Verification gate evaluation and command-based verification checks
- Context budget planning and compaction signaling
- Event-first recovery via replayable runtime telemetry
- Structured event persistence and replay support
- Proposal admission with effect commitment authorization
- Cost tracking with session budget alerts

## Documentation Model

- `guide`: operational usage
- `architecture`: implemented design and reliability boundaries
- `reference`: contract-level definitions
- `journeys`: operator entrypoints and cross-package review flows
- `solutions`: repository-native precedents and compound knowledge
- `troubleshooting`: incident-oriented remediation
- `research`: incubating notes and roadmap hypotheses before promotion to stable docs

Start from `docs/index.md` for the complete map.

## Related Docs

- Full documentation map: `docs/index.md`
- Local setup and install flow: `docs/guide/installation.md`
- Operator-facing CLI guide: `docs/guide/cli.md`
- Runtime contract: `docs/reference/runtime.md`
- Session and artifact boundaries: `docs/reference/session-lifecycle.md`,
  `docs/reference/artifacts-and-paths.md`
