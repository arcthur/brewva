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
- Skill catalog contracts: `packages/brewva-runtime/src/runtime/model`
- Extension facade: `@brewva/brewva-gateway/extensions` (`packages/brewva-gateway/src/extensions/api.ts`)
- Work Card projection assembly: `packages/brewva-cli/src/operator/inspect/work-card.ts`
- CLI entrypoint: `packages/brewva-cli/src/index.ts`

## Runtime Responsibilities

- Skill catalog discovery and refresh
- Work Card projection over goal, context, options, authority, work, evidence,
  and continuation anchors
- Evidence ledger recording, digest generation, and query
- Verification-gate policy input and command-based verification checks
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
- `research`: incubating notes and accepted decision provenance after stable
  docs absorb the contract

Start from `docs/index.md` for the complete map.

## Related Docs

- Full documentation map: `docs/index.md`
- Local setup and install flow: `docs/guide/installation.md`
- Operator-facing CLI guide: `docs/guide/cli.md`
- Runtime contract: `docs/reference/runtime.md`
- Session and artifact boundaries: `docs/reference/session-lifecycle.md`,
  `docs/reference/artifacts-and-paths.md`
