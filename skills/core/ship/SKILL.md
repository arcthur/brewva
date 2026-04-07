---
name: ship
description: Use when implemented and reviewed work needs release readiness checks, merge-path
  clarity, or operator-facing handoff.
stability: stable
selection:
  when_to_use: Use when implemented and reviewed work needs release readiness checks, merge-path clarity, or operator-facing handoff.
  examples:
    - Prepare this work for release.
    - Check whether this change is ready to ship.
    - Summarize the final ship blockers and merge path.
  phases:
    - ready_for_acceptance
intent:
  outputs:
    - ship_report
    - release_checklist
    - ship_decision
  semantic_bindings:
    ship_report: ship.ship_report.v1
    release_checklist: ship.release_checklist.v1
    ship_decision: ship.ship_decision.v1
effects:
  allowed_effects:
    - workspace_read
    - local_exec
    - runtime_observe
  denied_effects:
    - workspace_write
resources:
  default_lease:
    max_tool_calls: 90
    max_tokens: 160000
  hard_ceiling:
    max_tool_calls: 130
    max_tokens: 220000
execution_hints:
  preferred_tools:
    - exec
    - read
    - workflow_status
  fallback_tools:
    - grep
    - ledger_query
    - skill_complete
references:
  - skills/meta/skill-authoring/references/authored-behavior.md
  - references/release-readiness-checklist.md
scripts:
  - scripts/check_release_gates.py
consumes:
  - change_set
  - files_changed
  - verification_evidence
  - review_report
  - review_findings
  - merge_decision
  - qa_report
  - qa_findings
  - qa_verdict
  - qa_checks
  - qa_missing_evidence
  - qa_confidence_gaps
  - qa_environment_limits
  - github_context
  - ci_findings
requires: []
---

# Ship Skill

## The Iron Law

```
NO SHIP DECISION WITHOUT CURRENT EVIDENCE FOR EVERY GATE
```

Make release readiness explicit and operational. This skill is a read-only
release engineer: it audits the release path and prepares operator handoff.
It does not patch product code or perform release mutations.

**Violating the letter of this rule is violating the spirit of this rule.**

## When to Use

- Work has been implemented and reviewed and now needs a release decision
- Final release checks, PR handoff, or merge-path clarity needed
- Operator-facing blockers must be surfaced before landing

**Do NOT use when:**

- Implementation or review is still in progress
- The real work is QA, not release readiness
- No concrete release target exists

## Workflow

### Phase 1: Rebuild release context

Collect current branch state, release target, review state, QA result, CI
status, and outstanding blockers from upstream artifacts.

**If upstream artifacts are missing**: Record each gap. Missing evidence is a
blocking gate, not an assumption to fill in.

### Phase 2: Choose release path

Make the target explicit: PR handoff, merge readiness, or deploy handoff.
These are not interchangeable.

**If the request doesn't specify**: Infer the narrowest credible path and state
that assumption. Do not default to the most optimistic interpretation.

### Phase 3: Evaluate release gates

Run `scripts/check_release_gates.py` with current evidence. The script returns
pass/fail for each gate deterministically.

**If any gate fails**: The decision cannot be `ready`. Period. Report the
blocking gates and what must change.

### Phase 4: Decide ship posture

- `ready`: evidence supports the intended release action, no material blockers
- `needs_follow_up`: close but missing CI, metadata, or bounded follow-up
- `blocked`: correctness, QA, approval, or safety is unresolved

**If new code edits are required**: Route back to implementation or QA. Do not
perform release-time patch work.

### Phase 5: Emit shipping artifacts

Produce `ship_report`, `release_checklist`, `ship_decision`.

## Scripts

- `scripts/check_release_gates.py` — Input: review_state, qa_state, ci_state,
  branch_state. Output: all_clear flag, per-gate results, blocking gate list.
  Run during Phase 3 before deciding ship posture.

## Decision Protocol

- Which exact release action is being judged: PR, merge, or deploy handoff?
- What evidence is current versus stale relative to the latest change?
- Which approval, CI, or repository-state gate still stands between now and the action?
- If this moved forward now, what operator burden or rollback risk would remain?
- Am I evaluating current evidence, or am I remembering evidence from an earlier state?

## Red Flags — STOP

If you catch yourself thinking any of these, STOP and return to Phase 1:

- "Review passed, so it's ready to ship" — review is one gate, not all gates
- "QA was inconclusive but it's probably fine" — inconclusive blocks `ready`
- "CI will pass eventually" — evaluate current state, not future hope
- "The branch is a little behind but that's okay" — diverged is not clean
- "I'll just fix this one thing before shipping" — ship does not patch code

## Common Rationalizations

| Excuse                                           | Reality                                                                                                     |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| "Review approved, so it's shippable"             | Review is one of four gates. Check all of them.                                                             |
| "QA was mostly good"                             | `inconclusive` or `fail` blocks `ready`. Partial evidence is not full evidence.                             |
| "CI is probably green by now"                    | Check. If unknown, the gate fails.                                                                          |
| "Just a one-liner, faster than switching skills" | Ship is read-only. A one-liner during ship bypasses review and verification gates. Route to implementation. |
| "We can fix it after merge"                      | That is a rollback story. Name it as a risk, not as a plan.                                                 |

## Concrete Example

Input: "Check whether this branch is ready for a PR and tell me what still blocks release."

```json
{
  "ship_decision": "needs_follow_up",
  "ship_report": {
    "release_path": "PR handoff",
    "evidence_summary": {
      "review": "ready — approved with no blocking findings",
      "qa": "pass — onboarding flow exercised, adversarial probe passed",
      "ci": "unknown — pipeline not yet triggered for latest push",
      "branch": "clean — no uncommitted changes, up to date with target"
    },
    "blocking_gates": ["ci"],
    "operator_next_step": "Trigger CI pipeline. Once green, PR is ready to open."
  },
  "release_checklist": [
    { "gate": "review", "status": "clear", "detail": "Approved, no blocking findings" },
    { "gate": "qa", "status": "clear", "detail": "Pass with adversarial coverage" },
    { "gate": "ci", "status": "blocking", "detail": "Pipeline not yet run on latest commit" },
    { "gate": "branch", "status": "clear", "detail": "Clean, up to date" }
  ]
}
```

## Handoff Expectations

- `ship_report` tells the operator what is ready, what evidence backs the
  claim, and the exact next release action.
- `release_checklist` enumerates gating checks, remaining approvals,
  repository state, and deployment-sensitive concerns.
- `ship_decision` reflects real release posture, not optimistic intent.
- The handoff names which release path was evaluated and which action still
  remains for an operator, CI system, or GitHub workflow.

## Stop Conditions

- The requested release path is unclear and cannot be inferred
- Repository or credential context cannot support the intended release action
- Code or QA work is still the real blocker, not release mechanics
- A gate cannot be evaluated because its upstream evidence is completely absent
