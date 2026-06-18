---
id: sol-2026-06-17-stale-claim-verification-in-doc-audits
title: Doc audits verify stale claims against the whole codebase, not symbol tables
status: active
problem_kind: incident
module: docs
boundaries:
  - docs.reference.events
  - docs.audit
source_artifacts:
  - investigation_record
  - review_findings
tags:
  - documentation
  - audit
  - event-naming
  - verification
updated_at: 2026-06-17
---

# Doc Audits Verify Stale Claims Against The Whole Codebase, Not Symbol Tables

## Problem

A documentation audit that compares prose against code can wrongly conclude that
an event or symbol "does not exist" and propose deleting accurate documentation.
The risk is highest for runtime events, because Brewva emits some of them as
inline string literals rather than from a named constant, and carries a
dotted-versus-underscored split between the runtime emit `kind` and the
canonical/persisted form.

## Symptoms

During a `docs/reference/events/**` audit run by parallel review agents, finders
reported that `tape.handoff` and `worker.results.cleared` "do not exist" and
recommended deleting their documentation. Both are real, live events. Acting on
the findings would have removed accurate reference content.

## Failed Attempts

- Trusting a finder's "not found -> delete" reasoning without independent
  verification.
- Searching only the delegation constant table
  (`packages/brewva-vocabulary/src/internal/delegation.ts`, the `*_EVENT_TYPE`
  constants) for the event name. `worker.results.cleared` has no constant there,
  so the search returned zero and looked like proof of absence.

## Solution

Before deleting or renaming any event or symbol in docs, verify against the
whole codebase, not a single constant file:

- grep all of `packages/`, not just the vocabulary constant table.
- account for two emit shapes: a named constant (`const X_EVENT_TYPE = "..."`)
  AND a bare string literal passed to `emit`
  (`ctx.emit(sessionId, "worker.results.cleared", { ... })`). The literal form
  has no constant to grep.
- account for the dotted-versus-underscored duality: the runtime emit `kind` is
  often dotted (for example `tool.result.recorded`), while the
  canonical/persisted/projected form may be underscored
  (`tool_result_recorded`). Searching one form alone misses the other.

`worker.results.cleared` is emitted as a literal in
`runtime-ops-builders/session.ts` and consumed in `runtime-ops-projections.ts`;
`tape.handoff` is a real ops record type used in `context-evidence.ts` and the
four-port tape adapter. Both survived the audit only because each "does not
exist" claim was re-verified before any deletion.

## Why This Works

Brewva's runtime-ops events frequently emit literals and carry a
dotted/underscored split between runtime kind and canonical form, so a
symbol-table-only search is a false-negative generator. A whole-tree search
across both emit shapes is the reliable existence check.

## Prevention

- Treat every "stale / delete / rename" finding as a hypothesis requiring a
  positive code citation (a real emit or definition site), not the absence of a
  constant.
- When findings are bulk-generated (for example several parallel review agents),
  expect false positives on literal-emitted or dual-named events and verify each
  high-impact deletion individually before acting.

## References

- `docs/reference/events/tools.md`
- `docs/reference/events/workers.md`
- `packages/brewva-gateway/src/hosted/internal/session/runtime-ops-builders/session.ts`
- `packages/brewva-gateway/src/hosted/internal/session/runtime-ops-builders/runtime-ops-projections.ts`
- `packages/brewva-gateway/src/hosted/internal/context/evidence/context-evidence.ts`
