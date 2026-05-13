# Brewva Test Topology

This repository uses a centralized `test/` tree with five layers.

## Layers

- `test/unit/**`
  - White-box tests are allowed.
  - Imports from `packages/*/src/**` are allowed.
  - Do not spawn CLI processes or rely on network/providers.
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
- `test/fitness/**`
  - Repository fitness checks: architecture boundaries, docs, links, generated inventories, and reference guards.
  - These tests do not count as product-chain proofs or public contract coverage.
  - `bun run test:fitness` runs the whole `test/fitness/**` layer.
  - `bun run test:docs` is the docs-only subset under `test/fitness/docs/**`.

## Naming

Each file must end with one of:

- `*.unit.test.ts`
- `*.contract.test.ts`
- `*.system.test.ts`
- `*.live.test.ts`
- `*.fitness.test.ts`

Do not use ambiguous file labels such as `e2e-ish` or `characterization`.

## Helper Usage

- Shared helpers live under `test/helpers.ts` and `test/helpers/**`.
- Import shared helpers directly from those root paths. Do not add layer-local re-export trees under `test/<layer>/helpers/**`.
- Do not create local `createWorkspace`, `waitUntil`, or `withTimeout` clones when an equivalent helper exists.
- Do not call `setTimeout` directly from tests or subtree helpers; add shared timing primitives under `test/helpers/**` instead.
- Shared fixtures live under `test/fixtures/**`; keep them semantic, not mirror-only.
- Local `*.helpers.ts` files are allowed when they encode subtree-specific setup or assertions that do not belong in the global helper surface.

## Placement Rules

- A test that imports `packages/*/src/**` belongs in `unit`.
- A test that proves a package public surface belongs in `contract`.
- A test that proves a deterministic user flow belongs in `system`.
- A test that depends on a real provider, webhook, or live account belongs in `live`.
- A test that reads package source text or asserts repository structure belongs in `fitness`.
- If one test file mixes multiple layers, split it into separate files.
- Weak assertions such as empty throw checks, truthy checks, and defined-only checks are policy failures unless they are replaced with observable error or state expectations.
