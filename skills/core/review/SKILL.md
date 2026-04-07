---
name: review
description: Use when a diff or change plan needs findings-first risk review, merge
  readiness assessment, or conformance checking.
stability: stable
selection:
  when_to_use: Use when a diff or change plan needs findings-first risk review, merge readiness assessment, or conformance checking.
  examples:
    - Review this diff for risks and regressions.
    - Assess whether this change is ready to merge.
    - Find review findings in this patch.
  phases:
    - investigate
    - verify
intent:
  outputs:
    - review_report
    - review_findings
    - merge_decision
  semantic_bindings:
    review_report: review.review_report.v1
    review_findings: review.review_findings.v1
    merge_decision: review.merge_decision.v1
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
scripts:
  - scripts/activate_lanes.py
  - scripts/validate_lane_outcome.py
  - scripts/detect_secret_exposure.py
  - scripts/synthesize_lane_dispositions.py
consumes:
  - change_set
  - files_changed
  - design_spec
  - execution_plan
  - verification_evidence
  - impact_map
  - risk_register
  - implementation_targets
  - planning_posture
requires: []
---

# Review Skill

## The Iron Law

```
NO MERGE DECISION WITHOUT EVIDENCE FROM EVERY ACTIVATED LANE
```

Judge risk, not style. Surface the highest-value findings first and make
merge safety explicit.

**Violating the letter of this rule is violating the spirit of this rule.**

## When to Use

- Reviewing a diff or change plan
- Checking merge readiness
- Assessing regression, compatibility, or operational risk

**Do NOT use when:**

- There is no concrete review target
- The real work is debugging or repository analysis

## Workflow

### Phase 1: Build review context

Summarize scope, intent, critical paths, and available evidence. Treat
`design_spec`, `execution_plan`, and `risk_register` as core planning evidence.

**If planning evidence is missing or stale**: Widen the review lens. Missing
evidence is itself a finding.

### Phase 2: Activate review lanes

Run `scripts/activate_lanes.py` with `change_categories`, `changed_file_classes`,
and evidence availability flags. The script returns the exact lane set.

Always-on: `review-correctness`, `review-boundaries`, `review-operability`.
Conditional: `review-security`, `review-concurrency`, `review-compatibility`,
`review-performance` — activated deterministically by the script.

For non-trivial review, fan out lanes via `subagent_fanout`.

**If the script widens to full conditional set**: Review evidence is weak.
Proceed with all lanes rather than guessing which to skip.

### Phase 3: Security gate

Run `scripts/detect_secret_exposure.py` on changed files. This is a gate,
not a score — any finding blocks the review regardless of other lane outcomes.

**If `clean: false`**: Add a blocking finding. Do not proceed to merge readiness.

### Phase 4: Synthesize and decide

Run `scripts/synthesize_lane_dispositions.py` with `activated_lanes` (from
Phase 2) AND all `lane_outcomes`. The script blocks if any activated lane is
unreported.

**If lanes disagree materially**: Keep the disagreement visible in
`review_report`. Do not smooth it away.
**If missing_lanes is non-empty**: The review is incomplete. Do not override.

### Phase 5: Emit findings-first output

Produce `review_findings`, `review_report`, `merge_decision`.

## Scripts

- `scripts/activate_lanes.py` — Input: change_categories, changed_file_classes,
  evidence flags. Output: always_on lanes, conditional lanes, activation_basis.
  Run before Phase 2 fan-out.
- `scripts/validate_lane_outcome.py` — Input: lane outcome object or array.
  Output: valid, errors. Enforces canonical child schema (lane, disposition,
  primaryClaim, findings required when non-clear, optional missingEvidence /
  openQuestions / strongestCounterpoint). Accepts snake_case compatibility
  aliases on input, but child review lanes should emit camelCase fields. Run on
  each lane result before synthesis.
- `scripts/detect_secret_exposure.py` — Input: files array with path + content.
  Output: clean (bool), findings. Security GATE — any finding = blocked.
  Run before Phase 4 synthesis.
- `scripts/synthesize_lane_dispositions.py` — Input: activated_lanes + lane_outcomes.
  Output: merge_decision, rationale, blocking/concern/missing lanes.
  Blocks if activated_lanes missing or if any lane unreported. Treats
  unresolved `missingEvidence` as inconclusive even when a lane otherwise says
  `clear`.

## Decision Protocol

Use these questions to keep the review anchored in behavior, not style:

- What can fail now that could not fail before this change?
- Which contract does the diff rely on without proving?
- Where could persisted state or user-visible behavior drift partially?
- What evidence is still missing but required before `merge_decision = ready`?
- If this merged today, what rollback burden is most likely?

## Red Flags — STOP

If you catch yourself thinking any of these, STOP:

- "The code looks clean" — without checking behavior risk
- "Style issues are the main problem" — while skipping correctness
- "Merge is safe" — without evidence from every activated lane
- "This lane has no findings" — when you didn't actually run the lane
- "The disagreement isn't important" — if two lanes disagree, keep it visible

## Common Rationalizations

| Excuse                              | Reality                                                                                |
| ----------------------------------- | -------------------------------------------------------------------------------------- |
| "Style issues are important"        | Not before behavior risk. Correctness first, style second.                             |
| "Planning evidence is optional"     | Missing evidence means wider review, not narrower.                                     |
| "One lane cleared so it's fine"     | Every activated lane must clear. One clear lane doesn't compensate for a blocked one.  |
| "I'll note the concern but approve" | If the concern is material, `needs_changes`. Don't hide risk behind approval language. |

## Concrete Example

Input: "Review the routing refactor for regressions."

```json
{
  "review_findings": [
    {
      "condition": "Internal routing types exported from public entrypoint",
      "impact": "Widens public API surface, creating semver commitment",
      "evidence": "Diff adds export in contracts/index.ts",
      "next_action": "Move to @brewva/brewva-runtime/internal"
    }
  ],
  "review_report": {
    "summary": "Boundary lane flagged public export widening. Compatibility lane flagged semver risk.",
    "activated_lanes": [
      "review-correctness",
      "review-boundaries",
      "review-operability",
      "review-compatibility"
    ],
    "activation_basis": "category:public_api->review-compatibility; category:package_boundary->review-compatibility",
    "missing_evidence": [],
    "precedent_consult_status": "no_relevant_precedent_found"
  },
  "merge_decision": "needs_changes"
}
```

## Handoff Expectations

- `review_findings` ordered from highest to lowest value. May be empty when all
  lanes clear — do not invent findings to pad output.
- `review_report` records activated lanes, activation basis, blind spots, and
  precedent consult status.
- `merge_decision` matches the findings. Never a detached summary label.

## Stop Conditions

- There is no concrete review target
- Verification evidence is too weak to support a merge decision
- The real work is debugging or repository analysis
