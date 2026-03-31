---
name: learning-research
description: Retrieve repository precedents and preventive guidance before non-trivial
  planning or review.
stability: stable
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

## Intent

Query the repository-native precedent layer before non-trivial work turns into a
fresh plan or a fresh review narrative.

## Trigger

Use this skill when:

- planning posture is `moderate`, `complex`, or `high_risk`
- a debugging handoff needs prior repository-specific failure patterns
- review needs repository precedent rather than only diff-local reasoning

## Workflow

### Step 1: Establish the retrieval target

Define the problem class, module, boundary, and risk posture before searching.
Do not query the precedent layer with a vague restatement of the user request.

### Step 2: Query the precedent layer explicitly

Use `knowledge_search` against `docs/solutions/**` first, then adjacent stable
or bootstrap sources when the solution corpus is sparse.

### Step 3: Separate precedent from adjacent guidance

Distinguish canonical repository precedents from architecture docs, reference
docs, research notes, and troubleshooting material. Source type matters.

### Step 4: Emit proof-of-consult artifacts

Produce:

- `knowledge_brief`: what the precedent layer teaches the next owner
- `precedent_refs`: matched precedent records; use an empty array when there is
  no relevant precedent
- `preventive_checks`: concrete checks or guardrails the next skill should
  preserve
- `precedent_query_summary`: search scope, filters, and why the query shape was
  chosen
- `precedent_consult_status`: `matched` or `no_relevant_precedent_found`

## Interaction Protocol

- Retrieval is explicit pull, not hidden recall. Show the consulted precedent
  layer instead of implying that prior knowledge was magically available.
- Ask questions only when the search target is ambiguous enough to change the
  module, boundary, or problem kind being queried.
- Prefer a compact precedent packet over a long literature survey. The goal is
  to change the next decision, not to restate every matching document.

## Retrieval Questions

Use these questions to keep precedent lookup disciplined:

- Which boundary or module most likely owns this work?
- Is this a repository-specific precedent, a stable contract, or only adjacent
  research?
- Which prior failure or decision pattern would most reduce downstream churn?
- What preventive checks should travel forward even if no exact precedent exists?

## Proof-of-Consult Protocol

- Non-trivial work must leave evidence that the precedent layer was consulted.
- When there is no relevant precedent, say so explicitly through
  `precedent_consult_status` and an empty `precedent_refs` list rather than
  silently skipping retrieval.
- Preserve query context in `precedent_query_summary` so later review can judge
  whether the search posture was too narrow.

## Handoff Expectations

- `knowledge_brief` should teach `design` or `review` what matters from the
  precedent layer without requiring a second round of document hunting.
- `precedent_refs` should identify the exact records consulted, not just a vague
  category name.
- `preventive_checks` should be concrete enough to appear later in design,
  review, QA, or verification reasoning.
- `precedent_query_summary` should be auditably specific: search terms,
  filters, source types, and scope.

## Stop Conditions

- the task is demonstrably trivial and precedent retrieval would only add noise
- repository, boundary, or problem kind are too ambiguous to search credibly
- the available corpus is missing and no adjacent bootstrap sources exist

## Anti-Patterns

- treating hidden memory as a substitute for explicit precedent lookup
- flattening stable docs and solution records into one undifferentiated summary
- returning a generic research dump instead of a planning packet
- claiming no precedent exists without preserving query context

## Example

Input: "Before we redesign the WAL recovery path, find prior repository-specific replay and rollback precedents."

Output: `knowledge_brief`, `precedent_refs`, `preventive_checks`, `precedent_query_summary`, `precedent_consult_status`.
