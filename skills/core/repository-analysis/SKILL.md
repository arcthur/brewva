---
name: repository-analysis
description: Build a reliable repository snapshot, impact map, and planning posture
  before design, debugging, or review.
stability: stable
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
    - skill_complete
references:
  - skills/meta/skill-authoring/references/authored-behavior.md
consumes: []
requires: []
---

# Repository Analysis Skill

## Intent

Build a path-grounded understanding of the codebase that downstream skills can reuse.

## Trigger

Use this skill when:

- the repository or module boundary is unfamiliar
- a task needs impact analysis before implementation
- debugging or review requires structural context

## Workflow

### Step 1: Map the active surface

Identify entrypoints, main packages, ownership boundaries, and the hot path relevant to the request.

### Step 2: Narrow to the task-bearing path

Prefer the smallest set of files and boundaries that explain the request. Keep
expanding only while uncertainty is still material.

### Step 3: Build the reusable snapshot

Produce:

- `repository_snapshot`: main zones, responsibilities, and key paths
- `impact_map`: structured scope and classifier output with:
  - `summary`
  - `affected_paths`
  - `boundaries`
  - `high_risk_touchpoints`
  - `change_categories`
  - `changed_file_classes`
- `planning_posture`: `trivial`, `moderate`, `complex`, or `high_risk`
- `unknowns`: gaps that still block confident action

### Step 4: Stop broad scanning

Once the hot path and boundary map are clear, stop expanding and hand off.

## Interaction Protocol

- Re-ground the user on the specific path you are mapping, not on the whole
  repository.
- Ask questions only when the target surface is genuinely ambiguous or when
  multiple product boundaries could own the request.
- Prefer a recommended reading path over a giant inventory dump. The goal is to
  reduce future uncertainty, not to prove you scanned many files.

## Mapping Questions

Use these questions to avoid aimless scanning:

- Which entrypoint or public boundary is most likely to own this request?
- What file or module would have to change if the user's complaint is real?
- Which adjacent boundary is most likely to create hidden blast radius?
- What unknown still blocks downstream design, review, or debugging work?
- What planning posture best matches the actual blast radius and evidence depth
  required here?

## Search Protocol

- Start from likely entrypoints, public boundaries, and ownership seams.
- Expand outward only when the current evidence cannot explain responsibility,
  coupling, or expected impact.
- Treat directory listings, symbol searches, and grep results as routing aids.
  They are not the analysis itself.
- Stop once downstream design, debugging, or review can act without repeating
  the same exploration.

## Handoff Expectations

- `repository_snapshot` should explain the main zones, their responsibilities,
  and the specific path relevant to the request.
- `impact_map` should identify likely touchpoints, ownership boundaries, and
  blast-radius concerns so downstream skills know where to look first.
- `impact_map.change_categories` should use the canonical review taxonomy when
  the relevant risk class is clear.
- `impact_map.changed_file_classes` should always be populated with at least one
  canonical file class so review can classify the change deterministically even
  when `change_categories` stays broad.
- `planning_posture` should classify the next planning step conservatively.
  Use `trivial` only for demonstrably local, low-risk work. Use `high_risk`
  for public, persisted, security-sensitive, or consistency-sensitive changes.
- `unknowns` should be concrete and decision-relevant. Record what is still
  unclear and why it blocks confident action.

## Stop Conditions

- entrypoints cannot be identified from the local repo
- generated or external code hides the real ownership boundary
- the request depends on systems not present in the workspace

## Anti-Patterns

- reading random files without a hypothesis
- dumping directory trees without explaining why they matter
- confusing file count with architectural importance
- continuing to scan after the hot path is already clear

## Example

Input: "Map the runtime-to-gateway-to-cli path and identify high-risk coupling points."

Output: `repository_snapshot`, `impact_map`, `planning_posture`, `unknowns`.
