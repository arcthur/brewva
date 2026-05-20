# Decision: Subagent Orchestration V2 Role Taxonomy And Trigger Governance

## Metadata

- Decision: Brewva accepts the role-first Subagent Orchestration V2 public
  surface.
- Date: `2026-05-15`
- Status: accepted
- Stable docs:
  - `docs/guide/features.md`
  - `docs/guide/orchestration.md`
  - `docs/journeys/operator/background-and-parallelism.md`
  - `docs/reference/skills.md`
  - `docs/reference/tools.md`
  - `docs/reference/tools/delegation.md`
  - `docs/reference/events/README.md`
- Code anchors:
  - `packages/brewva-gateway/src/delegation/catalog/registry.ts`
  - `packages/brewva-gateway/src/delegation/target-resolution.ts`
  - `packages/brewva-gateway/src/delegation/delegation-store.ts`
  - `packages/brewva-gateway/src/delegation/orchestrator.ts`
  - `packages/brewva-gateway/src/delegation/structured-outcome.ts`
  - `packages/brewva-tools/src/contracts/subagent.ts`
  - `packages/brewva-tools/src/families/delegation/subagent-run/schemas.ts`
  - `packages/brewva-tools/src/families/delegation/subagent-knowledge-adopt.ts`
  - `packages/brewva-runtime/src/delegation/types.ts`
  - `packages/brewva-runtime/src/delegation/adoption.ts`

## Decision Summary

- Public subagent invocation is now role-first. Normal callers provide `agent`,
  optional compatible `skillName`, and task packet fields; low-level routing
  fields stay on maintainer diagnostics.
- The public role taxonomy is exactly `navigator`, `explorer`, `worker`,
  `verifier`, and `librarian`. New public input does not keep `advisor`,
  `qa`, or `patch-worker` aliases.
- The five roles stay contractually distinct through result mode, execution
  envelope, managed-tool set, model category, and adoption contract:
  `evidence`, `consult`, `patch`, `verifier`, and `knowledge`.
- Delegation Gate guidance is prompt-visible and resolver-auditable. It records
  role, gate reason, task identity, `forkTurns`, model category, and model route
  facts in v3 records, but it is not a hidden scheduler or team-mode trigger.
- Current-version records must carry the v3 identity, execution, and adoption
  fields; legacy delegation contract normalization is no longer part of the
  read model.
- A2A delivery belongs to channel agents. Subagents expose status, outcome,
  cancellation, and adoption through delegation receipts rather than audit
  messaging tools.
- Patch and knowledge authority remains parent-owned. Worker patches require
  worker-result adoption, and librarian knowledge proposals require an explicit
  knowledge-adoption receipt before they can support authoritative docs,
  claims, or solution records.

## Superseded by

- N/A
