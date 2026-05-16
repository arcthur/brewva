---
name: extract
description: Evidence-backed structured data extraction from noisy or free-form input.
selection:
  when_to_use:
    Use when noisy or free-form input must be converted into validated structured data with
    stable keys.
references:
  - references/contract-validation.md
  - references/projection-patterns.md
  - references/repair-loop-protocol.md
  - templates/extraction-report.md
  - references/example.md
  - references/rationalizations.md
scripts:
  - scripts/validate_extraction.py
---

# Extract Skill

## The Iron Law

```
NO CONFIDENT JSON WITHOUT SOURCE EVIDENCE FOR EVERY REQUIRED FIELD
```

Turn messy input into durable structured data. Make the repair logic explicit.
Fields without source evidence are `null`, not invented.

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

See `references/rationalizations.md` for the anti-pattern table.

## Concrete Example

See `references/example.md` for the grounded example output shape.

## Handoff Expectations

- `structured_payload` stable enough for downstream tools without reparsing.
- `extraction_report` explains confidence, repairs, and unresolved ambiguities.

## Stop Conditions

- No stable schema can be defined from the request
- Source ambiguity is too high to repair safely
- The task is summarization, not structured extraction
