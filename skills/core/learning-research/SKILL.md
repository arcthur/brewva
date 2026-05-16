---
name: learning-research
description: Retrieve repository precedents and preventive guidance before non-trivial planning or review.
selection:
  when_to_use: Use when a non-trivial task needs repository precedents, prior failure patterns, or
    preventive guidance before deeper execution.
references:
  - references/example.md
  - references/rationalizations.md
---

# Learning Research Skill

## The Iron Law

```
NO PLANNING WITHOUT EXPLICIT PRECEDENT CONSULT
```

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

### Phase 1: Establish the retrieval target

Define the problem class, module, boundary, and risk posture before searching. Construct a specific query shape.

**If the problem class is too vague to search credibly**: Stop. Ask for clarification or return to the upstream skill that should have framed the problem.
**If query shape is specific**: Proceed to Phase 2.

### Phase 2: Query the precedent layer explicitly

Use `knowledge_search` against `docs/solutions/**` first, then adjacent stable or bootstrap sources when the solution corpus is sparse.

**If `knowledge_search` is unavailable or returns no results**: Search `docs/solutions/` manually via `grep` and `read`. Do not skip the consult.
**If results are returned**: Proceed to Phase 3.

### Phase 3: Separate precedent from adjacent guidance

Distinguish canonical repository precedents from architecture docs, reference docs, research notes, and troubleshooting material. Source type matters for downstream trust.

**If all results are adjacent guidance with no direct precedent**: Set `precedent_consult_status` to `no_relevant_precedent_found` and still extract useful preventive checks.
**If precedent is found**: Proceed to Phase 4.

### Phase 4: Emit proof-of-consult artifacts

Produce `knowledge_brief`, `precedent_refs`, `preventive_checks`, `precedent_query_summary`, and `precedent_consult_status`.

**If `precedent_query_summary` does not include search terms, filters, and scope**: Return to Phase 2 and record them. The consult must be auditable.
**If artifacts are complete**: Hand off to downstream skills.

## Decision Protocol

- Which boundary or module most likely owns this work?
- Is this a repository-specific precedent, a stable contract, or only adjacent research?
- Which prior failure or decision pattern would most reduce downstream churn?
- What preventive checks should travel forward even if no exact precedent exists?
- Was the search posture narrow enough to miss relevant precedent?

## Red Flags — STOP

If you catch yourself thinking any of these, STOP and return to Phase 1:

- "I already know what the precedent says from prior context"
- "No results means no precedent exists" (without checking query specificity)
- "I'll summarize the whole docs folder instead of targeting the query"
- "This research is taking too long, I'll skip the consult"
- "The precedent is probably outdated so I'll ignore it"

## Common Rationalizations

See `references/rationalizations.md` for the anti-pattern table.

## Concrete Example

See `references/example.md` for the grounded example output shape.

## Handoff Expectations

- `knowledge_brief` teaches `plan` or `review` what matters from the precedent layer without requiring a second round of document hunting.
- `precedent_refs` identify the exact records consulted, not just vague category names.
- `preventive_checks` are concrete enough to appear later in planning, review, a verifier pass, or command-backed verification reasoning.
- `precedent_query_summary` is auditably specific: search terms, filters, source types, and scope.

## Stop Conditions

- The task is demonstrably trivial and precedent retrieval would only add noise.
- Repository, boundary, or problem kind are too ambiguous to search credibly.
- The available corpus is missing and no adjacent bootstrap sources exist.
- The same precedent consult was already performed in this session with the same query shape.
