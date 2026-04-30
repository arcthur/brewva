---
name: knowledge-capture
description: Materialize canonical repository precedents under docs/solutions from
  terminal typed artifacts.
stability: stable
selection:
  when_to_use: Use when a resolved feature, bug, incident, or review lesson should be turned into reusable repository precedent.
  paths:
    - docs/solutions
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
    - delegation
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
references:
  - references/example.md
  - references/rationalizations.md
consumes:
  - investigation_record
  - review_findings
  - review_report
  - retro_findings
  - followup_recommendation
  - verification_evidence
  - design_spec
  - change_set
---

# Knowledge Capture Skill

## The Iron Law

```
NO SOLUTION RECORD WITHOUT AUTHORITATIVE SOURCE ARTIFACTS
```

## When to Use / When NOT to Use

Use when:

- a feature, bug fix, or incident has reached a meaningful terminal state
- a blocked delivery was resolved and the path should become reusable precedent
- a high-signal review, QA, or verification lesson should compound into the repository

Do NOT use when:

- authoritative source artifacts (investigation_record, review_report, design_spec) are missing
- the lesson is not yet stable enough to become repository precedent (work still in flight)
- the work belongs only in a promotion candidate or stable normative doc, not a solution record

## Workflow

### Phase 1: Classify the capture posture

Determine the problem kind and required source authority before writing anything.

**If the problem kind is `bugfix` or `incident` and `investigation_record` is missing**: Stop. Do not create a solution record from memory or transcript alone.
**If source authority is sufficient**: Proceed to Phase 2.

### Phase 2: Check for existing canonical precedent

Use `knowledge_search` to find related solution records before creating a new document.

**If an active canonical record for the same failure class exists**: Prefer updating it over creating a duplicate. Proceed to Phase 3 with update intent.
**If no existing record**: Proceed to Phase 3 with create intent.

### Phase 3: Synthesize the solution record

Preserve the engineering path: root cause, failed attempts, contradiction notes, and derivative links. Do not flatten hard-won signal into polished hindsight.

**If the synthesized record omits failed attempts that exist in the source artifacts**: Return and include them. Failed attempts are part of the precedent.
**If the record is faithful to source artifacts**: Proceed to Phase 4.

### Phase 4: Write or skip intentionally

Produce `solution_record`, `solution_doc_path`, and `capture_status`.

**If evidence is insufficient for a credible record**: Set `capture_status` to `skipped` with an explicit reason. Do not write a weak record to avoid appearing idle.
**If the record is written**: Hand off to downstream skills.

## Decision Protocol

- What problem class did we actually solve?
- Which source artifacts are authoritative for this lesson?
- Is there already an active precedent that should be updated instead of duplicated?
- What should the next planner or reviewer do differently because this record exists?
- Are there failed attempts or contradictions that must survive into the record?

## Red Flags — STOP

If you catch yourself thinking any of these, STOP and return to Phase 1:

- "I remember the fix, I don't need the investigation_record"
- "I'll write a clean summary and skip the failed attempts"
- "This is close enough to the existing record, I'll create a new one anyway"
- "The transcript has all the details I need"
- "I'll capture this now and verify the sources later"

## Common Rationalizations

See `references/rationalizations.md` for the anti-pattern table.

## Concrete Example

See `references/example.md` for the grounded example output shape.

## Handoff Expectations

- `solution_record` is rich enough to support deterministic document writing and later refresh.
- `solution_doc_path` points to the canonical repository location, not a temporary scratch artifact.
- `capture_status` explains whether the repository knowledge plane was extended, revised, or intentionally left unchanged.
- Failed attempts and contradiction notes survive into the record so downstream consumers inherit the full engineering path.

## Stop Conditions

- Authoritative source artifacts are missing.
- The lesson is not yet stable enough to become repository precedent.
- The work belongs only in a promotion candidate or stable normative doc.
- An existing canonical record already covers this failure class with no material delta.
