# Decision: Brewva Standard Utility Boundary

## Metadata

- Decision: Brewva owns a leaf standard utility package for domain-neutral primitives
- Date: `2026-05-07`
- Status: accepted
- Stable docs:
  - `skills/project/shared/package-boundaries.md`
  - `skills/project/shared/source-map.md`
  - `docs/reference/token-cache.md`
- Code anchors:
  - `packages/brewva-std/package.json`
  - `packages/brewva-std/src/async.ts`
  - `packages/brewva-std/src/collections.ts`
  - `packages/brewva-std/src/hash.ts`
  - `packages/brewva-std/src/json.ts`
  - `packages/brewva-std/src/markdown.ts`
  - `packages/brewva-std/src/node/fs.ts`
  - `packages/brewva-std/src/text.ts`
  - `packages/brewva-std/src/unknown.ts`
  - `test/fitness/std-boundary.fitness.test.ts`
  - `test/unit/std`

## Decision Summary

- `@brewva/brewva-std` is Brewva's repo-owned standard utility package for domain-neutral primitives that were previously duplicated across runtime, gateway, provider-core, tools, recall, deliberation, session-index, substrate, box, CLI, channels, and MCP adapter code.
- The package is leaf-only: it depends on no other `@brewva/*` packages, exposes explicit subpaths only, and intentionally has no root export.
- Accepted subpaths are `async`, `collections`, `hash`, `json`, `markdown`, `node/fs`, `text`, and `unknown`; Node-only helpers stay under `/node/*`.
- `remeda`, `p-limit`, `@noble/hashes`, and `yaml` are implementation dependencies hidden behind std subpaths. `ohash` is intentionally absent because persistent identity, audit, cache, replay, and fingerprint digests use Brewva-owned canonical JSON plus SHA-256 semantics.
- Generic concurrency helpers use `@brewva/brewva-std/async`; runtime `ParallelBudgetManager` remains local because it owns session budgets, waiters, timeout and cancel reasons, event recording, and recovery semantics.
- Generic stable hashing, short IDs, cache fingerprints, and redacted digests use `@brewva/brewva-std/hash`; protocol-owned HMAC, PKCE, credential vault byte digests, and streaming byte fingerprints stay local.
- Provider cache fingerprints intentionally changed from historical 16-hex FNV values to opaque 64-hex SHA-256 digests and must be compared for equality only.
- `toJsonValue` normalizes non-finite numbers to `null` so std JSON coercion does not silently pollute numeric aggregates.
- Boundary quality tests prevent direct third-party utility imports outside std, root std imports, std-to-Brewva package imports, removed local helper file reintroduction, old generic helper names, and generic production SHA-256 drift outside allowlisted protocol, security, or byte-stream files.

## Superseded by

- None.
