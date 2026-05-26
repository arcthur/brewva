# Decision: Delegation Verification And Replay Inspection UX

## Metadata

- Decision: Delegation inspection is accepted as explicit-pull V2 projections over tape-backed receipts.
- Date: `2026-05-26`
- Status: accepted
- Stable docs:
  - `docs/guide/orchestration.md`
  - `docs/guide/cli.md`
  - `docs/journeys/operator/background-and-parallelism.md`
  - `docs/journeys/operator/inspect-replay-and-recovery.md`
  - `docs/reference/commands/credentials-inspect-insights.md`
  - `docs/reference/events/README.md`
  - `docs/reference/events/tools.md`
  - `docs/reference/events/workers.md`
  - `docs/reference/session-lifecycle.md`
  - `docs/reference/tools.md`
  - `docs/reference/tools/delegation.md`
  - `docs/reference/tools/workflow-and-scheduling.md`
- Code anchors:
  - `packages/brewva-vocabulary/src/internal/delegation.ts`
  - `packages/brewva-session-index/src/projection/delegation.ts`
  - `packages/brewva-session-index/src/api.ts`
  - `packages/brewva-cli/src/entry/main.ts`
  - `packages/brewva-cli/src/operator/inspect/report.ts`
  - `packages/brewva-cli/src/operator/inspect/output.ts`
  - `packages/brewva-tools/src/families/delegation/subagent-control.ts`
  - `packages/brewva-tools/src/families/delegation/delegation-inbox-query.ts`
  - `packages/brewva-tools/src/families/workflow/worker-results.ts`
  - `packages/brewva-gateway/src/delegation/runtime-events.ts`
  - `packages/brewva-gateway/src/delegation/run-finalization.ts`

## Decision Summary

- Tape remains the replay authority. Session-index delegation inspection is a
  rebuildable projection that may expose `runCards`, `workboard`, `inbox`,
  `timeline`, and `recoveryPreview`, but it cannot write tape or inject parent
  model context.
- Public delegated-run lifecycle is limited to `pending`, `running`,
  `blocked`, `completed`, `failed`, and `cancelled`. Timeout is a lifecycle
  reason; worker adoption is role disposition. Public inspection surfaces do
  not emit `timeout` or `merged` as lifecycle status.
- The public role taxonomy is the accepted V2 set:
  `navigator`, `explorer`, `worker`, `verifier`, and `librarian`. Default run
  cards hide model routing, agent spec, envelope, capability, and tool-scope
  internals; diagnostic views may expose them.
- Worker patch outcomes remain inert until the parent records
  `worker_results_apply` or `worker_results_reject`. Librarian knowledge
  proposals remain inert until the parent records
  `subagent_knowledge_adopt`.
- Verifier evidence and stale/superseded verification posture are advisory
  debt. They may appear in workboard, inbox, and timeline projections, but
  they do not enter worker merge/apply authority.
- `inbox_query`, `subagent_status`, `brewva inspect`, and `/inspect` expose
  explicit-pull inspection. Reading these views does not mark outcomes
  consumed and does not splice child output into parent context.
- `brewva --replay` remains the raw event dump for scripts that depend on
  payloads. `brewva --replay-timeline` is the redacted timeline projection with
  canonical event and receipt references.
- Recovery preview exposes structured primitives for resume, reasoning revert,
  session rewind, patch rollback, and adoption rejection with a structured
  continuation anchor.

## Superseded by

- None.
