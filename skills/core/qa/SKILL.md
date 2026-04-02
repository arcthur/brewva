---
name: qa
description: Verify the shipped behavior through realistic flows, try to break it,
  and leave reproducible evidence for release decisions.
stability: stable
intent:
  outputs:
    - qa_report
    - qa_findings
    - qa_verdict
    - qa_checks
    - qa_missing_evidence
    - qa_confidence_gaps
    - qa_environment_limits
  output_contracts:
    qa_report:
      kind: text
      min_words: 3
      min_length: 18
    qa_findings:
      kind: json
      min_items: 0
    qa_verdict:
      kind: enum
      values:
        - pass
        - fail
        - inconclusive
    qa_checks:
      kind: json
      min_items: 1
    qa_missing_evidence:
      kind: json
      min_items: 0
    qa_confidence_gaps:
      kind: json
      min_items: 0
    qa_environment_limits:
      kind: json
      min_items: 0
effects:
  allowed_effects:
    - workspace_read
    - local_exec
    - runtime_observe
resources:
  default_lease:
    max_tool_calls: 110
    max_tokens: 190000
  hard_ceiling:
    max_tool_calls: 150
    max_tokens: 250000
execution_hints:
  preferred_tools:
    - browser_open
    - browser_wait
    - browser_snapshot
    - browser_click
    - browser_fill
    - browser_screenshot
    - browser_diff_snapshot
    - exec
    - read
  fallback_tools:
    - browser_get
    - grep
    - skill_complete
references:
  - skills/meta/skill-authoring/references/authored-behavior.md
  - references/exploratory-regression-checklist.md
consumes:
  - design_spec
  - execution_plan
  - execution_mode_hint
  - risk_register
  - implementation_targets
  - change_set
  - files_changed
  - verification_evidence
  - review_report
  - review_findings
  - merge_decision
requires: []
---

# QA Skill

## Intent

Test the actual behavior, not just the intended diff, and turn real failures
into concrete release blockers or clearly scoped handoffs.

## Trigger

Use this skill when:

- the next question is whether the feature really works in realistic usage
- browser or executable behavior matters more than static code inspection
- release confidence requires executable evidence and adversarial probes

## Workflow

### Step 1: Establish a credible starting state

Identify whether the environment is testable, whether the target flow is
reachable, and whether the current branch or workspace state is coherent enough
to interpret failures.

If the environment, auth, or target URL is broken, say so early and classify it
as a blocker. Do not bury setup failure inside a vague QA summary.

### Step 2: Reconstruct the risk surface from the actual diff

Start from `change_set`, `files_changed`, `risk_register`, `review_findings`,
`implementation_targets`, and the intended user flow. Prefer a diff-aware test
path over generic click-around.

### Step 3: Run the highest-value test path

Prefer realistic end-to-end behavior over synthetic checklists. Use browser
evidence when the product surface is UI-driven; use executable verification when
the change is service or CLI heavy.

### Step 4: Decide pass, fail, or inconclusive

Do not silently repair defects. If the issue implies design drift, unclear
ownership, or weak reproduction, stop and report instead of guessing. Escalate
repairs back to implementation instead of mutating product code inside QA.

Recognize your own rationalizations:

- "The code looks correct based on my reading." Reading is not verification.
- "The implementer's tests already pass." Verify independently.
- "This is probably fine." Probably is not verified.
- "This would take too long." Run the strongest bounded check you can and record the limits honestly.
- "I do not have the exact tool." Check the available managed tools before downgrading the verdict.

### Step 5: Emit QA artifacts

Produce:

- `qa_report`: tested flows, what passed, what failed, and what changed
- `qa_findings`: ranked failures or residual concerns
- `qa_verdict`: `pass`, `fail`, or `inconclusive`
- `qa_checks`: executed checks with command or tool identity, observed output, probe type, and evidence refs
- `qa_missing_evidence`: evidence that should exist before stronger release claims are made
- `qa_confidence_gaps`: remaining uncertainty after the executed checks
- `qa_environment_limits`: environment or access limits that prevented stronger validation

## Interaction Protocol

- Ask only when the environment, target URL, credentials, or acceptance target
  are too unclear to test safely.
- Prefer browser-first evidence when the user risk is visible behavior. Do not
  substitute static reasoning for the real flow when the UI is the product.
- Re-ground on the changed user flow before opening the browser or running
  executable checks.
- Treat executable evidence as mandatory for a pass verdict.
- Recommend the release path you believe the evidence supports. Do not hide
  behind a neutral report when the right verdict is obvious.

## QA Questions

Use these questions to pick the right test path:

- Which user-visible path is most likely to fail for the reasons this diff is risky?
- What setup or environment assumption must be true before this result means anything?
- If the first failing path passes, what second path would still meaningfully reduce uncertainty?
- What evidence must be captured now so `ship` does not have to trust prose?

## Test Execution Protocol

- Start from the narrowest realistic flow that can fail for the reasons this
  diff is dangerous.
- Use `files_changed`, `risk_register`, and `review_findings` to pick the first
  path. Use `risk_register.required_evidence` and
  `execution_plan[*].verification_intent` to decide which probes matter first.
  QA is not a generic tour of the app.
- Treat saved snapshots, screenshots, command output, and after-fix reruns as
  first-class evidence. If evidence cannot be replayed by another operator, it
  is too weak.
- If you did not run the check, do not emit it as a passed `qa_check`. Record
  the missing probe under `qa_missing_evidence` instead.
- When setup is missing, record the missing prerequisite and downgrade to
  `inconclusive` instead of pretending the flow was validated.
- At least one executed check should be adversarial, boundary-seeking, or
  otherwise aimed at breaking the claimed happy path.
- `qa_verdict = pass` requires covering the plan-declared `required_evidence`.
  Coverage may come from the current `qa_checks` or from fresh authoritative
  `runtime.verification.*` evidence. If the required evidence was not covered,
  stay `inconclusive`.

## QA Decision Protocol

- Prefer the narrowest realistic flow that can prove or disprove release
  confidence quickly.
- Do not patch product code from QA by default. Hand off defects instead.
- Report instead of fixing when the defect points to wrong scope, wrong design,
  missing product decisions, or any change that belongs to implementation.
- Treat missing environments, broken auth, and irreproducible behavior as
  `inconclusive`, not as silent skips.

## Release Confidence Gate

- [ ] The highest-risk realistic path was actually exercised.
- [ ] The observed result is backed by replayable evidence.
- [ ] At least one adversarial or edge-oriented probe was attempted.
- [ ] Remaining uncertainty is named explicitly as `qa_confidence_gaps` or `qa_environment_limits`.

## Handoff Expectations

- `qa_report` should tell `ship` exactly what was exercised, what changed during
  QA, and what confidence level was earned.
- `qa_findings` should be reproducible and actionable, not generic complaints.
- `qa_verdict` should summarize real release confidence, not just the count of
  found issues.
- `qa_checks` should preserve command or tool identity, observed output, and
  probe types on every entry; command-based checks also preserve exit codes,
  and artifact refs stay supplemental rather than replacing observed output, so
  later release or debugging work does not restart from zero.
- The handoff should explain which risky path was exercised first, why that path
  was chosen, and why the verdict is `pass`, `fail`, or `inconclusive`.

## Stop Conditions

- the target environment cannot be reached or exercised credibly
- the real blocker is unresolved design or review debt, not QA execution
- the requested product surface cannot be tested with current access

## Anti-Patterns

- calling unit-test output "QA" without checking real behavior
- fixing product code inside QA without an explicit escalation
- skipping browser or runtime evidence when the user-facing flow is the actual risk
- reporting results without a release-oriented verdict

## Example

Input: "Exercise the staging onboarding flow, try to break the risky path, and tell me if this is safe to ship."

Output: `qa_report`, `qa_findings`, `qa_verdict`, `qa_checks`, `qa_missing_evidence`, `qa_confidence_gaps`, `qa_environment_limits`.
