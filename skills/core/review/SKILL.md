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
      kind: json
      min_keys: 7
      required_fields:
        - summary
        - activated_lanes
        - activation_basis
        - missing_evidence
        - residual_blind_spots
        - precedent_query_summary
        - precedent_consult_status
      field_contracts:
        summary:
          kind: text
          min_words: 3
          min_length: 18
        activated_lanes:
          kind: json
          min_items: 1
        activation_basis:
          kind: json
          min_items: 1
        missing_evidence:
          kind: json
          min_items: 0
        residual_blind_spots:
          kind: json
          min_items: 0
        precedent_query_summary:
          kind: text
          min_words: 3
          min_length: 18
        precedent_consult_status:
          kind: json
          min_keys: 1
          required_fields:
            - status
          field_contracts:
            status:
              kind: enum
              values:
                - consulted
                - no_match
                - not_required
            precedent_refs:
              kind: json
              min_items: 1
        lane_disagreements:
          kind: json
          min_items: 1
    review_findings:
      kind: json
      min_items: 0
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
    - knowledge_search
    - subagent_fanout
  fallback_tools:
    - subagent_run
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
  - references/review-lanes.md
  - references/security-concurrency.md
consumes:
  - change_set
  - files_changed
  - design_spec
  - verification_evidence
  - impact_map
  - risk_register
  - planning_posture
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

Summarize scope, intent, critical paths, consulted precedents, and available
evidence.

### Step 2: Evaluate risk lanes

Always inspect correctness / invariants, contracts / boundaries, and
verification / operability. Activate conditional lanes from canonical
`impact_map.change_categories` when available, otherwise from canonical
`changedFileClasses` derived from `impact_map.changed_file_classes` or the
current `files_changed` artifact. Widen when the available evidence is stale or
missing.

For non-trivial review work, prefer explicit internal lane fan-out through
`subagent_fanout` using the built-in review delegates:

- always-on: `review-correctness`, `review-boundaries`, `review-operability`
- conditional: `review-security`, `review-concurrency`,
  `review-compatibility`, `review-performance`

If `impact_map`, `design_spec`, or `verification_evidence` is weak, stale, or
missing, widen the lane set rather than narrowing it. If canonical
classification is unavailable for non-trivial review, widen to the full
conditional lane set instead of guessing.

Each delegated review lane should emit a structured `review` outcome that keeps
the lane visible to the parent reviewer. The canonical child fields are:

- `lane`
- `disposition`: `clear`, `concern`, `blocked`, or `inconclusive`
- `primaryClaim`
- `findings` when material issues exist
- `missingEvidence` when the lane cannot clear on evidence alone
- `openQuestions` for residual blind spots
- `strongestCounterpoint` when the lane has a meaningful internal caveat
- `confidence`

### Step 3: Decide the actual next action

Determine whether the change is ready, needs implementation follow-up, or is
blocked on missing evidence or a deeper design problem.

### Step 4: Emit findings-first output

Produce:

- `review_findings`: ordered issues with evidence
- `review_report`: structured disclosure with `summary`, lane activation,
  missing evidence, blind spots, `precedent_query_summary`, and precedent
  consult status
- `merge_decision`: `ready`, `needs_changes`, or `blocked`

## Interaction Protocol

- Do not spend review budget on compliments or stylistic trivia before checking
  correctness and merge safety.
- Re-ground on the intended design and available verification before judging the
  diff in isolation.
- If a user-facing decision is needed, recommend the merge path you actually
  believe is safest instead of presenting symmetric options.
- If critical metadata is missing, widen the review lens rather than narrowing
  it. Missing evidence is itself review evidence.
- Preserve proof of consult for repository precedents. Non-trivial review
  should record consulted precedents or an explicit no-match result, plus the
  query context used to reach that conclusion.

## Review Questions

Use these questions to keep the review anchored in behavior instead of style:

- What can fail now that could not fail before this change?
- Which contract, invariant, or ownership boundary does the diff rely on
  without proving?
- Where could persisted state, external effects, or user-visible behavior drift
  partially rather than fail cleanly?
- What evidence is still missing but required before `merge_decision = ready`?
- If this merged today, what rollback, mitigation, or operator burden is most
  likely?

## Findings Protocol

- Prioritize behavior risk over style.
- Each finding should make four things clear: the condition, the impact, the
  evidence, and the expected next action.
- Treat missing verification, stale design conformance, and runtime-boundary
  violations as first-class findings, not footnotes.
- If the real problem is an unconfirmed bug rather than a review issue, say so
  and direct the next step toward debugging.
- Preserve review-lane disclosure in `review_report`: activated lanes,
  activation basis, missing evidence, residual blind spots,
  `precedent_query_summary`, and precedent consult status.
- If internal lane delegates disagree materially, keep the disagreement visible
  in `review_report` instead of smoothing it away.
- If a delegated lane clears, say so with `disposition = clear` rather than
  fabricating a finding just to satisfy output shape.

## Merge Readiness Gate

Before setting `merge_decision` to `ready`, mentally clear this gate:

- [ ] The intended behavior still matches the current design and scope.
- [ ] Verification evidence is current relative to the latest risky change.
- [ ] No unresolved finding remains that could corrupt state, break contracts,
      or cause operator-visible regressions.
- [ ] Any remaining residual risk is named explicitly and is truly acceptable,
      not merely unverified.

## Merge Decision Protocol

- `ready`: no material correctness, safety, or evidence gaps remain.
- `needs_changes`: the change is salvageable, but concrete issues must be fixed
  before merge.
- `blocked`: merge safety cannot be established because the design is wrong, the
  evidence is missing, or the risk is outside acceptable bounds.

## Handoff Expectations

- `review_findings` may be empty when every activated lane clears without a
  material issue; do not invent a finding just to pad output shape.
- `review_findings` should be ordered from highest to lowest value and should be
  actionable by implementation without reinterpreting the review.
- `review_report` should record assumptions, activated lanes, blind spots,
  precedent consult status, and residual risk so downstream ship decisions know
  what was and was not covered.
- `merge_decision` should match the findings and evidence; it should never be a
  detached summary label.
- When review work fans out into internal lane delegates, prefer completing the
  parent skill through `skill_complete` with `reviewEnsemble` so the canonical
  review outputs are synthesized from durable lane outcomes instead of copied by
  hand.

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
