---
name: structured-extraction
description: Use when noisy or free-form input must be converted into validated
  structured data with stable keys.
stability: stable
selection:
  when_to_use: Use when noisy or free-form input must be converted into validated structured data with stable keys.
  examples:
    - Extract this text into a schema.
    - Normalize this free-form input into structured JSON.
    - Turn these notes into validated fields.
  phases:
    - execute
intent:
  outputs:
    - structured_payload
    - extraction_report
  output_contracts:
    structured_payload:
      kind: json
      min_keys: 1
      min_items: 1
    extraction_report:
      kind: text
      min_words: 3
      min_length: 18
effects:
  allowed_effects:
    - workspace_read
    - local_exec
    - runtime_observe
  denied_effects:
    - workspace_write
resources:
  default_lease:
    max_tool_calls: 70
    max_tokens: 140000
  hard_ceiling:
    max_tool_calls: 110
    max_tokens: 200000
execution_hints:
  preferred_tools:
    - read
    - exec
  fallback_tools:
    - grep
    - skill_complete
references:
  - skills/meta/skill-authoring/references/authored-behavior.md
  - references/contract-validation.md
  - references/projection-patterns.md
  - references/repair-loop-protocol.md
  - templates/extraction-report.md
scripts:
  - scripts/validate_extraction.py
consumes:
  - browser_observations
requires: []
---

# Structured Extraction Skill

## The Iron Law

```
NO CONFIDENT JSON WITHOUT SOURCE EVIDENCE FOR EVERY REQUIRED FIELD
```

Turn messy input into durable structured data. Make the repair logic explicit.
Fields without source evidence are `null`, not invented.

**Violating the letter of this rule is violating the spirit of this rule.**

## When to Use

- Free-form text must be normalized into a schema
- Extraction quality matters more than raw summarization
- Downstream systems need stable keys instead of prose

**Do NOT use when:**

- No stable schema can be defined from the request
- The task is ordinary summarization rather than structured extraction

## Workflow

### Phase 1: Define the target shape

Name the schema, required fields, optional fields, and field types.

**If no stable schema can be defined**: Stop. Say so directly.

### Phase 2: Extract and validate

Extract values from the source. For each field:

- Evidence-backed → populate with value
- Mechanically repairable → repair and log the repair
- Ambiguous → keep ambiguity explicit (e.g., `"P1_or_P2"`)
- No source evidence → set to `null`

Run `scripts/validate_extraction.py` with the schema and payload.

**If validation fails**: Fix missing required fields or type errors. Do not
invent content to pass validation.

### Phase 3: Emit artifacts

Produce `structured_payload` and `extraction_report`.
Use `templates/extraction-report.md` for the report structure.

## Scripts

- `scripts/validate_extraction.py` — Input: schema (required_fields, field_types)
  - payload. Output: valid, missing_required, type_errors, null_fields.
    Run after extraction to catch structural issues.

## Decision Protocol

- Which fields are directly supported by source evidence?
- Which fields can be repaired mechanically versus only guessed semantically?
- Where should ambiguity stay explicit instead of being normalized away?
- What downstream consumer makes this schema worth enforcing?

## Red Flags — STOP

If you catch yourself thinking any of these, STOP:

- "I'll fill this field with a reasonable guess" — null is more honest
- "The schema requires it so I'll invent something" — source evidence or null
- "This ambiguity is probably X" — keep it explicit
- "Close enough to the schema" — run the validator

## Common Rationalizations

| Excuse                                    | Reality                                                                   |
| ----------------------------------------- | ------------------------------------------------------------------------- |
| "The field is obviously X"                | Obvious to you, not supported by source. Use null.                        |
| "Downstream needs a value"                | Downstream needs a correct value. Null with explanation beats wrong data. |
| "I'll note the uncertainty in the report" | Note it AND set the field to null. Report doesn't excuse invention.       |
| "The source probably means X"             | Probably is not evidence. Keep the ambiguity.                             |

## Concrete Example

Input: "Extract a triage record from: 'Deploy broke prod at 3pm. Users seeing
500s on /api/checkout. Rolled back at 3:15. Not sure if config or auth
middleware. Sarah saw memory spikes. P1 or P2, needs triage.'"

```json
{
  "structured_payload": {
    "incident_id": null,
    "severity": "P1_or_P2",
    "affected_endpoint": "/api/checkout",
    "symptom": "HTTP 500 errors on checkout endpoint",
    "timeline": { "detected": "15:00", "mitigated": "15:15", "action": "rollback" },
    "suspected_causes": ["config change", "new auth middleware"],
    "supplemental_signals": [{ "source": "Sarah", "observation": "memory spikes" }],
    "root_cause": null,
    "status": "needs_triage"
  },
  "extraction_report": "Extracted 8/10 fields. severity is ambiguous (P1 or P2) — kept as explicit uncertainty. incident_id and root_cause are null (no source evidence). Source quality: noisy."
}
```

## Handoff Expectations

- `structured_payload` stable enough for downstream tools without reparsing.
- `extraction_report` explains confidence, repairs, and unresolved ambiguities.

## Stop Conditions

- No stable schema can be defined from the request
- Source ambiguity is too high to repair safely
- The task is summarization, not structured extraction
