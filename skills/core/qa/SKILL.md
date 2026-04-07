---
name: qa
description: Use when shipped behavior must be validated through realistic flows and
  executable evidence before release.
stability: stable
selection:
  when_to_use: Use when shipped behavior must be validated through realistic flows, adversarial probes, or executable evidence.
  examples:
    - QA this feature in realistic usage.
    - Try to break this flow and record evidence.
    - Verify the behavior end to end, not just statically.
  phases:
    - verify
intent:
  outputs:
    - qa_report
    - qa_findings
    - qa_verdict
    - qa_checks
    - qa_missing_evidence
    - qa_confidence_gaps
    - qa_environment_limits
  semantic_bindings:
    qa_report: qa.qa_report.v1
    qa_findings: qa.qa_findings.v1
    qa_verdict: qa.qa_verdict.v1
    qa_checks: qa.qa_checks.v1
    qa_missing_evidence: qa.qa_missing_evidence.v1
    qa_confidence_gaps: qa.qa_confidence_gaps.v1
    qa_environment_limits: qa.qa_environment_limits.v1
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
  - references/qa-taxonomy.md
scripts:
  - scripts/classify_qa_verdict.py
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

## The Iron Law

```
NO PASS VERDICT WITHOUT EXECUTABLE EVIDENCE
```

Test the actual behavior, not the intended diff. Turn real failures into
concrete release blockers. Reading code is not verification.

**Violating the letter of this rule is violating the spirit of this rule.**

## When to Use

- The next question is whether the feature really works in realistic usage
- Browser or executable behavior matters more than static code inspection
- Release confidence requires executable evidence and adversarial probes

**Do NOT use when:**

- There is no testable artifact yet
- The real work is design or implementation, not verification
- Static analysis alone answers the question

## Workflow

### Phase 1: Establish credible starting state

Verify: environment testable, target flow reachable, branch/workspace state
coherent enough to interpret failures.

**If environment is broken**: Stop. Classify as blocker. Emit `qa_environment_limits`
and set verdict to `inconclusive`. Do not bury setup failure inside a vague summary.

### Phase 2: Reconstruct risk surface from actual diff

Start from `change_set`, `files_changed`, `risk_register`, `review_findings`,
`implementation_targets`. Build a diff-aware test path. Use
`risk_register.required_evidence` and `execution_plan[*].verification_intent`
to pick probes.

**If upstream evidence is missing**: Widen the test surface. Missing evidence
means more testing, not less.

### Phase 3: Execute highest-value test path

Run realistic end-to-end checks. Use browser evidence for UI surfaces,
executable verification for service/CLI. At least one probe must be adversarial.
Use `templates/qa-report.md` for structuring output.
Classify findings using `references/qa-taxonomy.md` severity and categories.

**If a check cannot be executed**: Record it under `qa_missing_evidence`.
Do not emit it as a passed check.

### Phase 4: Classify verdict

Run `scripts/classify_qa_verdict.py` with execution summary. The script
returns the deterministic verdict from executed checks, failed checks,
adversarial coverage, and required-evidence coverage.

**If verdict is `fail`**: Do not silently repair. Escalate to implementation.
**If verdict is `inconclusive`**: Name exactly what is missing and why.

### Phase 5: Emit QA artifacts

Produce `qa_report`, `qa_findings`, `qa_verdict`, `qa_checks`,
`qa_missing_evidence`, `qa_confidence_gaps`, `qa_environment_limits`.

## Scripts

- `scripts/classify_qa_verdict.py` — Input: checks_executed, failed_checks,
  adversarial_attempted, environment_reachable, plus either
  required_evidence_covered or missing_required_evidence. Output: verdict and
  reason. Missing required evidence yields `inconclusive`; executed failing
  checks yield `fail`. Run after Phase 3, before emitting final artifacts.

## Decision Protocol

- Which user-visible path is most likely to fail for the reasons this diff is risky?
- What setup assumption must be true before this result means anything?
- If the first path passes, what second path would still reduce uncertainty?
- What evidence must be captured now so `ship` does not have to trust prose?
- Did I actually run the check, or am I reasoning about what it would show?

## Interaction Protocol

- Recognize your own rationalizations before downgrading or skipping a check.
- "The code looks correct based on my reading." Reading is not verification. Run it.
- Do not invent QA checks from code reading or expectation alone.
- Prefer a browser-first path for UI surfaces, executable traces for CLI/service
  behavior, and rerun the same failing path after any bounded fix.

## Red Flags — STOP

If you catch yourself thinking any of these, STOP and return to Phase 1:

- "The code looks correct based on my reading" — reading is not verification
- "The implementer's tests already pass" — verify independently
- "This is probably fine" — probably is not verified
- "This would take too long" — run the strongest bounded check and record limits
- "I don't have the exact tool" — check available managed tools before downgrading

## Common Rationalizations

| Excuse                                          | Reality                                                                                    |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------ |
| "Unit tests pass, so it works"                  | Unit tests are not QA. Real flows can fail with green unit tests.                          |
| "I read the code and it's correct"              | Reading is not execution. Run the check.                                                   |
| "Environment is too hard to set up"             | Record it as `inconclusive`. Do not fake a pass.                                           |
| "The happy path works, edge cases are unlikely" | At least one adversarial probe is mandatory. Skip it and the verdict stays `inconclusive`. |
| "Fixing it myself is faster"                    | QA does not patch product code. Hand off defects to implementation.                        |

## Concrete Example

Input: "Exercise the staging onboarding flow, try to break the risky path, and tell me if this is safe to ship."

```json
{
  "qa_verdict": "fail",
  "qa_findings": [
    {
      "severity": "high",
      "category": "functional",
      "description": "Email validation accepts malformed addresses with double dots",
      "evidence": "browser_snapshot: input 'user@test..com' accepted, form submitted",
      "reproducible": true
    }
  ],
  "qa_checks": [
    {
      "flow": "onboarding happy path",
      "probe_type": "happy_path",
      "tool": "browser_fill + browser_click",
      "observed": "Form submits, welcome screen shown",
      "status": "pass"
    },
    {
      "flow": "onboarding email validation",
      "probe_type": "adversarial",
      "tool": "browser_fill",
      "observed": "Malformed email accepted without error",
      "status": "fail"
    }
  ],
  "qa_missing_evidence": [],
  "qa_confidence_gaps": ["Password strength meter not exercised"],
  "qa_environment_limits": []
}
```

## Handoff Expectations

- `qa_report`: what was exercised, what changed, confidence level earned.
- `qa_findings`: reproducible, actionable, classified per `references/qa-taxonomy.md`.
- `qa_verdict`: real release confidence, not issue count.
- `qa_checks`: command/tool identity, observed output, probe type on every entry.
- Handoff explains which risky path was exercised first and why the verdict
  is `pass`, `fail`, or `inconclusive`.

## Stop Conditions

- The target environment cannot be reached or exercised credibly
- The real blocker is unresolved design or review debt, not QA execution
- The requested product surface cannot be tested with current access
- Setup requires credentials or approvals not available in the current context
