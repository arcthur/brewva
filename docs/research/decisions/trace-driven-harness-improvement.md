# Decision: Trace-Driven Harness Improvement

## Metadata

- Decision: Brewva records hosted Harness identity as advisory evidence, projects rebuildable Harness trace snapshots from tape, and exposes explicit-pull patrol and compare operations for governed Harness improvement.
- Date: `2026-06-01`
- Status: accepted
- Stable docs:
  - `docs/reference/commands/harness.md`
  - `docs/reference/events/harness.md`
  - `docs/reference/working-projection.md`
  - `docs/reference/events/README.md`
- Code anchors:
  - `packages/brewva-vocabulary/src/harness.ts`
  - `packages/brewva-gateway/src/harness/api.ts`
  - `packages/brewva-gateway/src/hosted/internal/session/managed-agent/session.ts`
  - `packages/brewva-gateway/src/hosted/internal/turn-adapter/runtime-provider-context.ts`
  - `packages/brewva-session-index/src/projection/harness.ts`
  - `packages/brewva-cli/src/operator/harness.ts`
  - `test/unit/vocabulary/harness.unit.test.ts`
  - `test/unit/session-index/harness-projection.unit.test.ts`
  - `test/unit/gateway/harness-patrol.unit.test.ts`
  - `test/unit/cli/harness-output.unit.test.ts`

## Decision Summary

- `@brewva/brewva-vocabulary/harness` owns the shared Harness manifest, trace snapshot, pattern candidate, eval report, advisory envelope, and deterministic clustering contracts.
- Hosted provider preparation records `harness.manifest.recorded` as a `custom` advisory event through the runtime kernel. The manifest stores only hashes, ids, selected names, policy identities, and source refs; raw prompts, raw tool schemas, credentials, environment values, and full provider payloads are rejected at the manifest boundary.
- `@brewva/brewva-session-index` schema version `7` stores `session_harness_trace_snapshots` as rebuildable DuckDB projection state. Event tape remains authoritative, and older index rows are reset and rebuilt instead of migrated.
- `@brewva/brewva-gateway/harness` owns control-plane snapshot building, deterministic patrol clustering, manifest comparison, and replay-backed candidate comparison. Runtime and kernel do not own Harness optimization or promotion.
- `brewva harness snapshots`, `brewva harness patrol`, and `brewva harness compare` are explicit-pull operator surfaces. `compare` supports current-runtime identity comparison, `--candidate-manifest <path>`, fixture replay with no-op tools, and explicit real target sessions.
- Promotion remains governed. Patrol and comparison reports are advisory artifacts and do not mutate prompts, skills, provider routing, recall ranking, or tool policy.

## Superseded by

- None.
