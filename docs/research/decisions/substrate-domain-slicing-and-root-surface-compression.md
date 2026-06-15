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
- substrate mechanisms are consumed through explicit subpaths: `./session`, `./prompt`, `./resources`, `./tools`, `./host-api`, `./provider`, `./compaction`, `./context-budget`, and `./agent-protocol`. (Amended — see WS5 amendment below; `./turn` was never published, and `./persistence`/`./provenance`/`./execution` were recovered.)
- `./contracts` mirrors the root contract-first vocabulary for callers that want an explicit contract import.
- domain-owned contracts such as tool definitions and provider model catalogs are imported from their owning domain subpaths, not from `./contracts`.
- prompt/resource implementations are no longer hidden under `session/`; hosted resource loading is public, while skill discovery stays internal.
- tool factories remain public under `./tools`; shared file, path, render, truncate, MIME, diff, and mutation-queue helpers stay internal under `tools/_shared`.
- repo-owned production packages must not import the substrate root for mechanisms; they import the owning domain subpath.
- compatibility with old root mechanism exports and old moved source paths is intentionally not preserved.

## Amendment — WS5 single-consumer seam recovery (`2026-06-15`)

- The `./persistence`, `./provenance`, and `./execution` mechanism subpaths are
  removed from the public surface. They had zero external production consumers;
  their implementations stay substrate-internal and are reached via relative
  paths (e.g. `prompt/templates.ts` uses `../provenance/source-info.js`,
  `tools/api.ts` re-exposes the execution tool-phase primitives through
  `./tools`). This applies the seam principle from
  `rfc-hosted-implementation-subtraction-and-ops-facade-collapse.md`: a public
  API with no second consumer is a hypothetical seam, not architecture — recover
  it and re-publish only if a real consumer appears.
- `substrate-entrypoint.contract.test.ts` now locks the absence of these three
  subpaths (rather than their presence).

## Builds On

- `docs/research/decisions/substrate-turn-loop-internalization.md`
- `docs/research/decisions/brewva-c2-full-internalization-and-kernel-substrate-boundaries.md`
- `docs/research/decisions/runtime-domain-slicing-and-controlled-extension-ports.md`
- `docs/research/decisions/provider-core-domain-slicing-and-driver-port-boundaries.md`

## Superseded by

- None.
