---
name: repository-analysis
description: Build a reliable repository snapshot, impact map, and planning posture
  before design, debugging, or review.
stability: stable
selection:
  when_to_use: Use when the task needs repository orientation, impact analysis, or boundary mapping before design, debugging, review, or execution.
  examples:
    - Analyze this repository before changing code.
    - Map the impacted modules and boundaries for this task.
    - Explain which files are likely affected by this request.
  phases:
    - align
    - investigate
intent:
  outputs:
    - repository_snapshot
    - impact_map
    - planning_posture
    - unknowns
  output_contracts:
    repository_snapshot:
      kind: text
      min_words: 3
      min_length: 18
    impact_map:
      kind: json
      min_keys: 6
      required_fields:
        - summary
        - affected_paths
        - boundaries
        - high_risk_touchpoints
        - change_categories
        - changed_file_classes
      field_contracts:
        summary:
          kind: text
          min_words: 3
          min_length: 18
        affected_paths:
          kind: json
          min_items: 1
        boundaries:
          kind: json
          min_items: 0
        high_risk_touchpoints:
          kind: json
          min_items: 0
        change_categories:
          kind: json
          min_items: 0
        changed_file_classes:
          kind: json
          min_items: 1
    planning_posture:
      kind: enum
      values:
        - trivial
        - moderate
        - complex
        - high_risk
    unknowns:
      kind: json
      min_items: 1
effects:
  allowed_effects:
    - workspace_read
    - runtime_observe
  denied_effects:
    - workspace_write
    - local_exec
resources:
  default_lease:
    max_tool_calls: 80
    max_tokens: 160000
  hard_ceiling:
    max_tool_calls: 120
    max_tokens: 220000
execution_hints:
  preferred_tools:
    - read
    - grep
  fallback_tools:
    - glob
    - lsp_symbols
    - lsp_find_references
    - ledger_query
consumes: []
references:
  - references/example.md
  - references/rationalizations.md
---

# Repository Analysis Skill

## The Iron Law

```
NO IMPACT MAP WITHOUT PATH-GROUNDED EVIDENCE
```

## When to Use / When NOT to Use

Use when:

- the repository or module boundary is unfamiliar
- a task needs impact analysis before implementation
- debugging or review requires structural context

Do NOT use when:

- the developer already has a clear, verified understanding of the affected paths
- the request is a problem-framing question, not a code-location question (use `discovery`)
- the task is precedent retrieval, not repository mapping (use `learning-research`)

## Workflow

### Phase 1: Map the active surface

Identify entrypoints, main packages, ownership boundaries, and the hot path relevant to the request.

**If entrypoints cannot be identified from the local repo**: Stop. Record what is missing in `unknowns`. Do not guess at ownership.
**If entrypoints are clear**: Proceed to Phase 2.

### Phase 2: Narrow to the task-bearing path

Follow the smallest set of files and boundaries that explain the request. Expand only while uncertainty is still material.

**If the path leads into generated or external code that hides real ownership**: Stop. Record the boundary gap in `unknowns`.
**If the path is traceable**: Proceed to Phase 3.

### Phase 3: Build the impact map

Produce `repository_snapshot`, `impact_map` (with all required fields), `planning_posture`, and `unknowns`.

**If any `affected_paths` entry was added without reading the actual file**: Remove it. Every path must come from evidence, not assumption.
**If the map is path-grounded**: Proceed to Phase 4.

### Phase 4: Stop broad scanning

Once the hot path and boundary map are clear, stop expanding. Do not scan more files to look thorough.

**If you are still scanning after the hot path is mapped**: Stop. You are past the point of useful return.
**If complete**: Hand off to downstream skills.

## Decision Protocol

- Which entrypoint or public boundary is most likely to own this request?
- What file or module would have to change if the user's complaint is real?
- Which adjacent boundary is most likely to create hidden blast radius?
- What unknown still blocks downstream planning, review, or debugging work?
- What planning posture matches the actual blast radius and evidence depth?

## Red Flags — STOP

If you catch yourself thinking any of these, STOP and return to Phase 1:

- "I'll list every file in the directory to be thorough"
- "This file is probably related" (without reading it)
- "I'll keep scanning — more coverage is better"
- "The boundary is obvious, I don't need to verify"
- "I'll add this path to the impact map just in case"

## Common Rationalizations

See `references/rationalizations.md` for the anti-pattern table.

## Concrete Example

See `references/example.md` for the grounded example output shape.

## Handoff Expectations

- `repository_snapshot` explains main zones, responsibilities, and the specific path relevant to the request.
- `impact_map` identifies likely touchpoints, ownership boundaries, and blast-radius concerns so downstream skills know where to look first.
- `impact_map.change_categories` uses the canonical review taxonomy when the relevant risk class is clear.
- `impact_map.changed_file_classes` is always populated with at least one canonical file class.
- `planning_posture` classifies conservatively. Use `trivial` only for demonstrably local, low-risk work. Use `high_risk` for public, persisted, security-sensitive, or consistency-sensitive changes.
- `unknowns` are concrete and decision-relevant: what is unclear and why it blocks confident action.

## Stop Conditions

- Entrypoints cannot be identified from the local repo.
- Generated or external code hides the real ownership boundary.
- The request depends on systems not present in the workspace.
- The hot path and boundary map are already clear from prior analysis in this session.
