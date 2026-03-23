---
name: review
description: Assess change risk, plan conformance, and merge safety with findings-first
  output and explicit residual risk.
stability: stable
intent:
  outputs:
    - review_report
    - review_findings
    - merge_decision
  output_contracts:
    review_report:
      kind: text
      min_words: 3
      min_length: 18
    review_findings:
      kind: json
      min_items: 1
    merge_decision:
      kind: enum
      values:
        - ready
        - needs_changes
        - blocked
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
    - lsp_diagnostics
    - lsp_symbols
    - lsp_find_references
    - ast_grep_search
    - ledger_query
    - skill_complete
references:
  - skills/meta/skill-authoring/references/authored-behavior.md
  - references/boundary-failure.md
  - references/contract-drift.md
  - references/security-concurrency.md
consumes:
  - change_set
  - design_spec
  - verification_evidence
  - impact_map
requires: []
---

# Review Skill

## Intent

Judge risk, not style. Surface the highest-value findings first and make merge safety explicit.

## Trigger

Use this skill when:

- reviewing a diff or change plan
- checking merge readiness
- assessing regression, compatibility, or operational risk

## Workflow

### Step 1: Build review context

Summarize scope, intent, critical paths, and available evidence.

### Step 2: Evaluate risk lanes

Inspect correctness, compatibility, data mutation, external exposure, and operational failure modes.

### Step 3: Decide the actual next action

Determine whether the change is ready, needs implementation follow-up, or is
blocked on missing evidence or a deeper design problem.

### Step 4: Emit findings-first output

Produce:

- `review_findings`: ordered issues with evidence
- `review_report`: scope, assumptions, gaps, residual risk
- `merge_decision`: `ready`, `needs_changes`, or `blocked`

## Interaction Protocol

- Do not spend review budget on compliments or stylistic trivia before checking
  correctness and merge safety.
- Re-ground on the intended design and available verification before judging the
  diff in isolation.
- If a user-facing decision is needed, recommend the merge path you actually
  believe is safest instead of presenting symmetric options.

## Findings Protocol

- Prioritize behavior risk over style.
- Each finding should make four things clear: the condition, the impact, the
  evidence, and the expected next action.
- Treat missing verification, stale design conformance, and runtime-boundary
  violations as first-class findings, not footnotes.
- If the real problem is an unconfirmed bug rather than a review issue, say so
  and direct the next step toward debugging.

## Merge Decision Protocol

- `ready`: no material correctness, safety, or evidence gaps remain.
- `needs_changes`: the change is salvageable, but concrete issues must be fixed
  before merge.
- `blocked`: merge safety cannot be established because the design is wrong, the
  evidence is missing, or the risk is outside acceptable bounds.

## Handoff Expectations

- `review_findings` should be ordered from highest to lowest value and should be
  actionable by implementation without reinterpreting the review.
- `review_report` should record assumptions, blind spots, and residual risk so
  downstream ship decisions know what was and was not covered.
- `merge_decision` should match the findings and evidence; it should never be a
  detached summary label.

## Stop Conditions

- there is no concrete review target
- verification evidence is too weak to support a merge decision
- the real work is debugging or repository analysis, not review

## Anti-Patterns

- leading with summaries before findings
- focusing on style while skipping behavior risk
- claiming merge safety without evidence or assumptions
- turning review into silent redesign without naming the design gap

## Example

Input: "Review the skills v2 runtime refactor for regressions and missing tests."

Output: `review_findings`, `review_report`, `merge_decision`.
