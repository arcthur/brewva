# Decision: Substrate Domain Slicing And Root Surface Compression

## Metadata

- Decision: Substrate is a domain-sliced mechanism package with a contract-only root and explicit mechanism subpaths.
- Date: `2026-05-06`
- Status: accepted
- Stable docs:
  - `docs/architecture/system-architecture.md`
  - `docs/reference/session-lifecycle.md`
  - `docs/reference/extensions.md`
  - `docs/reference/token-cache.md`
  - `docs/reference/configuration.md`
  - `skills/project/shared/package-boundaries.md`
  - `skills/project/shared/source-map.md`
- Code anchors:
  - `packages/brewva-substrate/src/public/index.ts`
  - `packages/brewva-substrate/src/{contracts,session,prompt,resources,tools,host-api,persistence,provider}/api.ts`
  - `packages/brewva-substrate/package.json`
  - `test/contract/substrate/substrate-entrypoint.contract.test.ts`
  - `test/fitness/substrate-domain-slicing.fitness.test.ts`

## Decision Summary

- `@brewva/brewva-substrate` root exports only cross-domain vocabulary that is not owned by a mechanism domain: context state, session phase, and thinking-level contracts.
- substrate mechanisms are consumed through explicit subpaths: `./session`, `./prompt`, `./resources`, `./tools`, `./host-api`, `./persistence`, `./provider`, and `./turn`.
- `./contracts` mirrors the root contract-first vocabulary for callers that want an explicit contract import.
- domain-owned contracts such as tool definitions and provider model catalogs are imported from their owning domain subpaths, not from `./contracts`.
- prompt/resource implementations are no longer hidden under `session/`; hosted resource loading is public, while skill discovery stays internal.
- tool factories remain public under `./tools`; shared file, path, render, truncate, MIME, diff, and mutation-queue helpers stay internal under `tools/_shared`.
- repo-owned production packages must not import the substrate root for mechanisms; they import the owning domain subpath.
- compatibility with old root mechanism exports and old moved source paths is intentionally not preserved.

## Builds On

- `docs/research/decisions/substrate-turn-loop-internalization.md`
- `docs/research/decisions/brewva-c2-full-internalization-and-kernel-substrate-boundaries.md`
- `docs/research/decisions/runtime-domain-slicing-and-controlled-extension-ports.md`
- `docs/research/decisions/provider-core-domain-slicing-and-driver-port-boundaries.md`

## Superseded by

- None.
