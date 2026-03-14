# Brewva Test Topology

This repository uses a centralized `test/` tree with five layers.

## Layers

- `test/unit/**`
  - White-box tests are allowed.
  - Imports from `packages/*/src/**` are allowed.
  - Do not spawn CLI processes or rely on network/provides.
- `test/contract/**`
  - Test package entrypoints and exported contracts only.
  - Do not import `packages/*/src/**`.
- `test/system/**`
  - Deterministic multi-package flow tests.
  - May spawn `bun` processes.
  - Do not import `packages/*/src/**`.
  - Do not depend on real external providers or live network APIs.
  - Keep this layer intentionally small; tests that only validate a single package surface or rely on synthetic fakes belong in `contract`.
- `test/live/**`
  - Real external dependency coverage only.
  - Do not import `packages/*/src/**`.
  - These tests are excluded from default PR gating.
- `test/quality/**`
  - Docs, links, reference guards, and other quality checks.
  - These tests do not count as product-chain proofs.
  - `bun run test:quality` runs the whole `test/quality/**` layer.
  - `bun run test:docs` is the docs-only subset under `test/quality/docs/**`.

## Naming

Each file must end with one of:

- `*.unit.test.ts`
- `*.contract.test.ts`
- `*.system.test.ts`
- `*.live.test.ts`
- `*.quality.test.ts`

Do not use ambiguous file labels such as `e2e-ish` or `characterization`.

## Helper Usage

- Shared helpers live under `test/helpers/**`.
- Do not create local `createWorkspace`, `waitUntil`, or `withTimeout` clones when an equivalent helper exists.
- Fixture builders that also seed required assets such as skills, `AGENTS.md`, or other domain-specific files are allowed when the shared workspace helper does not cover that setup.
- Layer-local shims may re-export from `test/helpers/**` to keep relative imports stable during migration.

## Placement Rules

- A test that imports `packages/*/src/**` belongs in `unit`.
- A test that proves a package public surface belongs in `contract`.
- A test that proves a deterministic user flow belongs in `system`.
- A test that depends on a real provider, webhook, or live account belongs in `live`.
- If one test file mixes multiple layers, split it into separate files.
