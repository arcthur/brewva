---
name: learning-research
description: Retrieve repository precedents and preventive guidance before non-trivial planning or review.
selection:
  when_to_use: Use when a non-trivial task needs repository precedents, prior failure patterns, or
    preventive guidance before deeper execution.
references:
  - references/strict-protocol.md
  - references/example.md
  - references/rationalizations.md
---

# Learning Research Skill

## The Iron Law

```
PLANNING AT MODERATE RISK OR ABOVE CONSULTS PRECEDENT OR STATES WHY NOT —
NEVER SKIPS IT SILENTLY
```

A consult is often minutes against hours of repeated churn; when it is not,
say so in the planning artifact and move on. The obligation is the recorded
decision, not the ritual.

## When to Use / When NOT to Use

Use when:

- planning posture is `moderate`, `complex`, or `high_risk`
- a debugging handoff needs prior repository-specific failure patterns
- review needs repository precedent rather than only diff-local reasoning

Do NOT use when:

- the task is demonstrably trivial and precedent retrieval would only add noise
- the problem is still unframed (use `discovery` first)
- repository mapping is needed, not precedent lookup (use `repository-analysis`)

## Workflow

<!-- self-eval-strict-scaffold:start -->

Until a recorded paired-calibration verdict demotes it, load
`references/strict-protocol.md` before Phase 1 and follow its tightened rules.

<!-- self-eval-strict-scaffold:end -->

### Phase 1: Establish the retrieval target

Define the problem class, module, boundary, and risk posture before searching. Construct a specific query shape.

**If the problem class is too vague to search credibly**: Stop. Ask for clarification or return to the upstream skill that should have framed the problem.
**If query shape is specific**: Proceed to Phase 2.

### Phase 2: Query the precedent layer explicitly

Use `knowledge_search` against `docs/solutions/**` first, then adjacent stable or bootstrap sources when the solution corpus is sparse.

**If `knowledge_search` is unavailable or returns no results**: Search `docs/solutions/` manually via `grep` and `read` before concluding no precedent exists — a missing tool is not a missing precedent.
**If results are returned**: Proceed to Phase 3.

### Phase 3: Separate precedent from adjacent guidance, and check it against reality

Distinguish canonical repository precedents from architecture docs, reference
docs, research notes, and troubleshooting material. Source type matters for
downstream trust.

A precedent is a descriptive claim about this repository, and descriptive
claims age: spot-check the consulted record against current code or runtime
evidence before letting it steer the plan. A precedent that contradicts
observed reality is reported as stale (route the correction to
`self-improve`), not silently followed and not silently dropped.

**If all results are adjacent guidance with no direct precedent**: Set `precedent_consult_status` to `no_relevant_precedent_found` and still extract useful preventive checks.
**If precedent is found and holds against reality**: Proceed to Phase 4.

### Phase 4: Emit proof-of-consult artifacts

Produce `knowledge_brief`, `precedent_refs`, `preventive_checks`, `precedent_query_summary`, and `precedent_consult_status`.

**If `precedent_query_summary` does not include search terms, filters, and scope**: Return to Phase 2 and record them. The consult must be auditable.
**If artifacts are complete**: Hand off to downstream skills.

## Rules

- `learning-research.consult-before-high-risk-planning` (controlled-exception) —
  Planning at `moderate`+ posture consults the precedent layer before
  committing to an approach. Exception evidence: a stated reason in the
  planning artifact (genuinely novel territory with no plausible precedent
  class, or a time-critical mitigation with the consult deferred to a named
  follow-up).
- `learning-research.report-stale-precedent` (non-negotiable) — A consulted
  precedent that contradicts current code or runtime evidence is reported as
  stale with the conflict routed to `self-improve`; it is never silently
  followed or silently dropped.
- `learning-research.auditable-consult` (non-negotiable) — A claimed consult
  records its search terms, filters, and scope; an unrecorded consult did
  not happen.
- `learning-research.retrieval-depth` (adaptive-heuristic) — Default: one
  targeted query per problem class, widened only while results still change
  the plan.

## Decision Protocol

- Which boundary or module most likely owns this work?
- Is this a repository-specific precedent, a stable contract, or only adjacent research?
- Which prior failure or decision pattern would most reduce downstream churn?
- What preventive checks should travel forward even if no exact precedent exists?
- Was the search posture narrow enough to miss relevant precedent?
- Does the precedent still match the code it describes — and if not, where
  does the correction get reported?

## Concrete Example

See `references/example.md` for the grounded example output shape.

## Handoff Expectations

- `knowledge_brief` teaches `plan` or `review` what matters from the precedent layer without requiring a second round of document hunting.
- `precedent_refs` identify the exact records consulted, not just vague category names.
- `preventive_checks` are concrete enough to appear later in planning, review, a verifier pass, or command-backed verification reasoning.
- `precedent_query_summary` is auditably specific: search terms, filters, source types, and scope.
- A skipped consult hands off the stated reason so downstream skills know the
  gap is deliberate, not forgotten.

## Stop Conditions

- The task is demonstrably trivial and precedent retrieval would only add noise.
- Repository, boundary, or problem kind are too ambiguous to search credibly.
- The available corpus is missing and no adjacent bootstrap sources exist.
- The same precedent consult was already performed in this session with the same query shape.
