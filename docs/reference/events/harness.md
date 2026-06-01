# Events: Harness

Harness events describe hosted control-plane identity for trace-driven
improvement. They are advisory evidence over canonical tape, not canonical
events and not replay authority.

## Advisory Manifest

`harness.manifest.recorded` is stored as a `custom` runtime event with
`namespace="runtime.ops"`, `kind="harness.manifest.recorded"`,
`version=1`, and `authority="advisory"`.

The payload schema is `brewva.harness.manifest.v1`.

Required identity:

- `manifestId`
- `sessionId`
- `attempt`
- provider/model/cache/request hashes when available
- prompt, tool, skill, capability, context, and plugin identities as hashes,
  ids, selected names, or source refs

The manifest must not persist raw prompt text, raw tool schemas, credentials,
environment values, or full provider payloads. Raw recovery belongs to existing
forensics and artifacts, not the Harness manifest.

## Projection Semantics

`session_harness_trace_snapshots` is a DuckDB session-index projection table.
It stores `brewva.harness.trace_snapshot.v1` JSON rows derived from:

- `harness.manifest.recorded`
- skill selection receipts
- tool surface and capability selection receipts
- context evidence and provider cache observations
- cost, tool outcome, suspension, and turn-end events

The table is rebuildable. Event tape remains authoritative. Schema version `7`
resets older session-index rows and rebuilds projections rather than migrating
compatibility state.

## Pattern Candidates

Trace patrol clusters snapshots into
`brewva.harness.pattern_candidate.v1` candidates. Required classes are:

- `provider_failure`
- `tool_contract`
- `context_pressure`
- `skill_surface_miss`
- `tool_surface_miss`
- `verification_hygiene`
- `cache_regression`

Candidates cite snapshot ids, event ids, manifest ids, occurrence count,
severity, confidence, and the governed promotion path. Patrol does not mutate
prompts, skills, provider routing, recall ranking, or tool policy.

## Comparison Reports

Harness comparison produces `brewva.harness.eval_report.v1`.

Default `manifest` mode compares the recorded manifest to the current runtime
identity, or to an explicit manifest-compatible JSON file supplied by
`--candidate-manifest`, and has
`sideEffectPolicy="no_provider_or_tool_execution"`. `fixture` mode forks the
source prefix into a target session with `replay-then-real`, then continues with
a fixture/faux provider and no-op tool executor. `real` mode uses hosted
provider, tool executor, and authority ports; it requires an explicit target
session and must not run against the source session.

Comparison reports include manifest ids, source/target session ids, divergence
event id, changed identity fields, regression flags, and execution counters
when a replay-backed mode runs.

## Code Pointers

- Vocabulary: `packages/brewva-vocabulary/src/harness.ts`
- Gateway API: `packages/brewva-gateway/src/harness/api.ts`
- Hosted manifest recording:
  `packages/brewva-gateway/src/hosted/internal/session/managed-agent/session.ts`
- Provider context identity:
  `packages/brewva-gateway/src/hosted/internal/turn-adapter/runtime-provider-context.ts`
- Session-index projection:
  `packages/brewva-session-index/src/projection/harness.ts`
