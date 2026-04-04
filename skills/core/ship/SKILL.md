---
name: ship
description: Convert reviewed and tested work into a release-ready handoff with explicit
  blockers, final checks, and release-path clarity.
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
  output_contracts:
    ship_report:
      kind: text
      min_words: 3
      min_length: 18
    release_checklist:
      kind: json
      min_items: 1
    ship_decision:
      kind: enum
      values:
        - ready
        - needs_follow_up
        - blocked
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

## Intent

Make release readiness explicit and operational instead of assuming review and
tests automatically imply a clean ship path.

This skill is a read-only release engineer workflow. It audits the requested
release path and prepares operator handoff; it does not patch product code or
silently perform release mutations.

## Trigger

Use this skill when:

- the work has been implemented and reviewed and now needs a release decision
- the team wants final release checks, PR handoff, or merge-path clarity
- operator-facing blockers must be surfaced before landing

## Workflow

### Step 1: Rebuild release context

Collect the current branch state, release target, workflow posture, review
state, QA result, and outstanding blockers.

### Step 2: Choose the release path you are evaluating

Make the target explicit:

- PR handoff
- merge readiness
- deploy handoff

If the request does not say which path matters, infer the narrowest credible
one and state that assumption.

### Step 3: Audit the actual release path

Check whether the work is ready for the intended outcome: PR creation, merge,
deploy preparation, or a clear operator handoff.

### Step 4: Decide ready, follow-up, or blocked

Use the strongest available evidence. Do not mark work ready when review, QA,
verification, CI, or release mechanics still leave unresolved risk.

### Step 5: Emit shipping artifacts

Produce:

- `ship_report`: current release posture, evidence, and operator-facing next step
- `release_checklist`: final checks, approvals, and unresolved blockers
- `ship_decision`: `ready`, `needs_follow_up`, or `blocked`

## Interaction Protocol

- Ask only when the target release path, repository target, or required approval
  boundary is unclear enough to risk operating on the wrong branch or outcome.
- Stay read-only with respect to product code and release side effects. If the
  next correct action is mutating GitHub, CI, or deployment state, describe the
  handoff instead of pretending it already happened.
- Re-ground on current review, QA, and verification evidence before speaking in
  release language.
- Recommend the release path you actually believe is safe. Do not hide behind a
  generic checklist if the release is clearly blocked.

## Release Questions

Use these questions before declaring anything shippable:

- Which exact release action is being judged: PR, merge, or deploy handoff?
- What evidence is current, and what evidence is stale relative to the latest change?
- Which approval, CI, or repository-state gate still stands between now and the intended action?
- If this moved forward now, what operator burden or rollback risk would remain?

## Ship Confirmation Gate

Before setting `ship_decision` to `ready`, clear this gate:

- [ ] The exact release path being judged is explicit: PR, merge, or deploy handoff.
- [ ] Review, QA, and verification evidence is current relative to the latest
      risky change, not inherited from an earlier diff state.
- [ ] No unresolved CI, approval, or repository-state blocker remains.
- [ ] Operator burden and rollback posture are named, not assumed away.

If any item is unclear, stop at `needs_follow_up` or `blocked` instead of
declaring readiness.

## Release Path Protocol

- Distinguish clearly between "ready for PR", "ready to merge", and
  "ready for deploy handoff". They are not interchangeable.
- Check repository hygiene before giving a positive verdict: branch intent, diff
  state, CI status, approval state, and any environment-specific blockers.
- If `ship` finds product correctness issues, route back to `implementation`,
  `review`, or `qa` instead of stretching release language to cover unfinished work.

## Release Decision Protocol

- `ready`: the evidence supports the intended release action and no material
  blockers remain.
- `needs_follow_up`: the work is close, but missing CI results, release metadata,
  or another bounded follow-up still blocks handoff.
- `blocked`: merge or release should not proceed because correctness, QA,
  approval, or operational safety is still unresolved.
- If new code edits are required, hand control back to implementation or QA
  instead of quietly performing release-time patch work.

## Handoff Expectations

- `ship_report` should tell the operator what is ready now, what evidence backs
  that claim, and what exact next release action is appropriate.
- `release_checklist` should enumerate gating checks, remaining approvals,
  repository state, and any deployment-sensitive concerns.
- `ship_decision` should summarize real release posture, not optimistic intent.
- The handoff must say which release path was evaluated and which release action
  still remains for an operator, CI system, or GitHub workflow.

## Stop Conditions

- the requested release path is unclear
- repository or credential context cannot support the intended release action
- code or QA work is still the real blocker

## Anti-Patterns

- treating review pass as automatic release permission
- patching product code inside a release workflow
- hiding CI, approval, or deployment blockers behind "looks fine"
- conflating "ready for PR" with "ready for production" without saying which

## Example

Input: "Check whether this branch is ready for a PR and tell me what still blocks release."

Output: `ship_report`, `release_checklist`, `ship_decision`.
