---
name: structured-extraction
description: Convert noisy text or semi-structured input into validated structured
  output with repair-minded discipline.
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
  - templates/extract-api-response.md
consumes:
  - browser_observations
requires: []
---

# Structured Extraction Skill

## Intent

Turn messy input into durable structured data and make the repair logic explicit.

## Trigger

Use this skill when:

- free-form text must be normalized into a schema
- extraction quality matters more than raw summarization
- downstream systems need stable keys instead of prose

## Workflow

### Step 1: Define the target shape

Name the schema, required fields, and repair rules.

### Step 2: Extract and validate

Normalize the input, repair obvious shape issues, and flag unresolved ambiguity.

### Step 3: Emit extraction artifacts

Produce:

- `structured_payload`: the structured result
- `extraction_report`: confidence, repairs, and unresolved gaps

## Interaction Protocol

- Re-ground on the target schema, required fields, and acceptable repair rules
  before extracting.
- Ask only when the output shape, source authority, or ambiguity policy is too
  unclear to extract safely.
- If the source cannot support a stable schema, say so directly instead of
  forcing a shape that only looks valid.

## Extraction Questions

Use these questions to keep extraction honest:

- Which fields are directly supported by source evidence?
- Which fields can be repaired mechanically versus only guessed semantically?
- Where should ambiguity stay explicit instead of being normalized away?
- What downstream consumer expectation makes this schema worth enforcing?

## Extraction Protocol

- Separate three things clearly: source evidence, repaired normalization, and
  unresolved ambiguity.
- Repair only obvious, well-justified shape problems. Do not invent semantic
  content to make a schema look complete.
- Prefer stable keys and explicit null or missing-state handling over prose
  escape hatches.
- Validation is part of the skill, not an optional cleanup pass.

## Pre-Delivery Checklist

- [ ] Every required field is either evidence-backed or explicitly unresolved.
- [ ] Repairs are mechanical and described in `extraction_report`.
- [ ] Missing or null states are explicit where source support is absent.
- [ ] The output is stable enough for downstream tooling without reparsing prose.

## Handoff Expectations

- `structured_payload` should be stable enough for downstream tools or skills to
  consume without reparsing the original text.
- `extraction_report` should explain confidence, repairs applied, ambiguities
  left unresolved, and any fields that need human or downstream judgment.

## Stop Conditions

- no stable schema can be defined from the request
- source ambiguity is too high to repair safely
- the task is ordinary summarization rather than structured extraction

## Anti-Patterns

- returning prose when a schema was requested
- silently inventing fields to satisfy shape requirements
- mixing extraction with downstream business decisions
- hiding source ambiguity behind confident-looking JSON

## Example

Input: "Extract a stable issue triage record from this noisy incident thread."

Output: `structured_payload`, `extraction_report`.
