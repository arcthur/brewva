---
name: learning-research
description: Retrieve repository precedents and preventive guidance before non-trivial
  planning or review.
stability: stable
selection:
  when_to_use: Use when a non-trivial task needs repository precedents, prior failure patterns, or preventive guidance before deeper execution.
  examples:
    - Find prior repository solutions for this problem.
    - Look up precedent before we implement this.
    - Gather repository-specific guidance for this debugging task.
  phases:
    - align
    - investigate
intent:
  outputs:
    - knowledge_brief
    - precedent_refs
    - preventive_checks
    - precedent_query_summary
    - precedent_consult_status
  output_contracts:
    knowledge_brief:
      kind: text
      min_words: 3
      min_length: 18
    precedent_refs:
      kind: json
    preventive_checks:
      kind: json
    precedent_query_summary:
      kind: text
      min_words: 3
      min_length: 18
    precedent_consult_status:
      kind: enum
      values:
        - matched
        - no_relevant_precedent_found
effects:
  allowed_effects:
    - workspace_read
    - runtime_observe
  denied_effects:
    - workspace_write
    - local_exec
resources:
  default_lease:
    max_tool_calls: 90
    max_tokens: 180000
  hard_ceiling:
    max_tool_calls: 130
    max_tokens: 240000
execution_hints:
  preferred_tools:
    - knowledge_search
    - read
    - grep
  fallback_tools:
    - ledger_query
    - workflow_status
    - skill_complete
references:
  - skills/meta/skill-authoring/references/authored-behavior.md
consumes:
  - repository_snapshot
  - impact_map
  - problem_frame
  - scope_decision
  - strategic_risks
  - planning_posture
  - root_cause
requires: []
---

# Learning Research Skill

## The Iron Law

```
NO PLANNING WITHOUT EXPLICIT PRECEDENT CONSULT
```

Violating the letter of this rule is violating the spirit of this rule.

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

| Excuse                                                      | Reality                                                                                        |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| "I remember the precedent from earlier"                     | Hidden recall is not explicit consult. Query the layer and cite what you find.                 |
| "No results, so no precedent exists"                        | A vague query returns no results. Refine the query before declaring absence.                   |
| "The precedent layer is sparse, so it's not worth checking" | Sparse layers still contain hard-won lessons. Check anyway.                                    |
| "Adjacent docs are close enough"                            | Architecture docs and solution records serve different functions. Label the source type.       |
| "I'll do the consult mentally and save time"                | Mental consult leaves no audit trail. Downstream review cannot verify what you did not record. |

## Concrete Example

Input: "Before we redesign the WAL recovery path, find prior repository-specific replay and rollback precedents."

Output:

```json
{
  "knowledge_brief": "Two prior solution records address WAL recovery. The replay-epoch-stale-drop fix (2024-11) established that replay must pin epoch to post-replay value before emitting events. The rollback-journal-corruption fix (2024-09) established that rollback artifacts must be written atomically. Both are directly relevant to any recovery path redesign.",
  "precedent_refs": [
    {
      "path": "docs/solutions/replay-epoch-stale-drop.md",
      "problem_class": "WAL replay",
      "key_lesson": "Pin epoch to post-replay value in ReplayService.finalize()"
    },
    {
      "path": "docs/solutions/rollback-journal-corruption.md",
      "problem_class": "rollback durability",
      "key_lesson": "Atomic write for rollback journal; never partial-flush"
    }
  ],
  "preventive_checks": [
    {
      "check": "Any new replay path must assert epoch >= current before event emit",
      "source": "replay-epoch-stale-drop.md"
    },
    {
      "check": "Rollback artifacts must use atomic write or rename pattern",
      "source": "rollback-journal-corruption.md"
    },
    {
      "check": "Recovery tests must include mid-replay crash scenario",
      "source": "inferred from both precedents"
    }
  ],
  "precedent_query_summary": "Searched docs/solutions/** for 'WAL', 'replay', 'rollback', 'recovery', 'epoch'. Two direct matches. Also checked docs/reference/events.md and docs/architecture/system-architecture.md for adjacent context on event pipeline durability.",
  "precedent_consult_status": "matched"
}
```

## Handoff Expectations

- `knowledge_brief` teaches `design` or `review` what matters from the precedent layer without requiring a second round of document hunting.
- `precedent_refs` identify the exact records consulted, not just vague category names.
- `preventive_checks` are concrete enough to appear later in design, review, QA, or verification reasoning.
- `precedent_query_summary` is auditably specific: search terms, filters, source types, and scope.

## Stop Conditions

- The task is demonstrably trivial and precedent retrieval would only add noise.
- Repository, boundary, or problem kind are too ambiguous to search credibly.
- The available corpus is missing and no adjacent bootstrap sources exist.
- The same precedent consult was already performed in this session with the same query shape.
