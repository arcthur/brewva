---
name: knowledge-capture
description: Materialize canonical repository precedents under docs/solutions from
  terminal typed artifacts.
stability: stable
intent:
  outputs:
    - solution_record
    - solution_doc_path
    - capture_status
  output_contracts:
    solution_record:
      kind: json
      min_keys: 4
    solution_doc_path:
      kind: text
      min_length: 4
    capture_status:
      kind: enum
      values:
        - created
        - updated
        - skipped
effects:
  allowed_effects:
    - workspace_read
    - workspace_write
    - runtime_observe
  denied_effects:
    - local_exec
resources:
  default_lease:
    max_tool_calls: 110
    max_tokens: 220000
  hard_ceiling:
    max_tool_calls: 150
    max_tokens: 280000
execution_hints:
  preferred_tools:
    - knowledge_capture
    - knowledge_search
    - read
    - grep
    - output_search
  fallback_tools:
    - subagent_fanout
    - skill_complete
references:
  - skills/meta/skill-authoring/references/authored-behavior.md
consumes:
  - investigation_record
  - review_findings
  - review_report
  - retro_findings
  - followup_recommendation
  - verification_evidence
  - design_spec
  - change_set
requires: []
---

# Knowledge Capture Skill

## Intent

Write repository-native compound knowledge back into `docs/solutions/**` so the
next planning or review cycle can reuse it explicitly.

## Trigger

Use this skill when:

- a feature, bug fix, or incident has reached a meaningful terminal state
- a blocked delivery was resolved and the path should become reusable precedent
- a high-signal review, QA, or verification lesson should compound into the
  repository

## Workflow

### Step 1: Classify the capture posture

Determine the problem kind and required source authority before writing
anything.

- `bugfix` and `incident` capture require `investigation_record`
- design or feature lessons should start from `design_spec`, `review_report`,
  and `retro_findings`
- transcript material is supplemental, not primary authority

### Step 2: Check for an existing canonical precedent

Use `knowledge_search` to find related solution records before creating a new
document. Prefer updating the active canonical record over creating a duplicate.

### Step 3: Synthesize a canonical solution record

Preserve the engineering path, including failed attempts, contradiction notes,
and derivative links to promotion candidates or stable docs when they exist.

### Step 4: Write or skip intentionally

Produce:

- `solution_record`: the structured capture packet used to write or update the
  canonical document
- `solution_doc_path`: the repository path written, updated, or `none` when the
  capture is intentionally skipped
- `capture_status`: `created`, `updated`, or `skipped`

## Interaction Protocol

- Default to authoritative typed artifacts first. Transcript and operator notes
  are allowed only as backfill.
- Ask questions only when source authority is too weak to distinguish between a
  new precedent, an update, or a skip.
- Preserve important contradictions instead of flattening them into a neat but
  misleading summary.

## Capture Questions

Use these questions to keep capture canonical rather than decorative:

- What problem class did we actually solve?
- Which source artifacts are authoritative for this lesson?
- Is there already an active precedent that should be updated?
- What should the next planner or reviewer do differently because this record
  now exists?

## Capture Protocol

- Do not create a bug-fix or incident precedent without `investigation_record`.
- Prefer updating an existing active record when the new work materially refines
  the same failure class.
- Mark derivative relationships explicitly when the same lesson also becomes a
  promotion candidate or a stable architecture/reference update.
- Use `skipped` only when the evidence is insufficient or when the lesson is a
  duplicate with no material delta.

## Handoff Expectations

- `solution_record` should be rich enough to support deterministic document
  writing and later refresh.
- `solution_doc_path` should point to the canonical repository location, not a
  temporary scratch artifact.
- `capture_status` should explain whether the repository knowledge plane was
  extended, revised, or intentionally left unchanged.

## Stop Conditions

- authoritative source artifacts are missing
- the lesson is not yet stable enough to become repository precedent
- the work belongs only in a promotion candidate or stable normative doc

## Anti-Patterns

- writing polished hindsight summaries that lose failed attempts
- creating duplicate solution docs for the same active failure class
- using transcript snippets as primary authority when typed artifacts exist
- skipping capture because the current session already "remembers" the fix

## Example

Input: "Record the replay bug fix so the next planner can find the root cause, failed attempts, and prevention guidance."

Output: `solution_record`, `solution_doc_path`, `capture_status`.
