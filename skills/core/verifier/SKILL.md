---
name: verifier
description: Behavior validation through realistic flows, adversarial probes, and executable evidence.
selection:
  when_to_use: Use when shipped behavior must be validated through realistic flows, adversarial
    probes, or executable evidence.
references:
  - references/exploratory-regression-checklist.md
  - references/verifier-taxonomy.md
  - references/example.md
  - references/rationalizations.md
scripts:
  - scripts/classify_verifier_verdict.py
---

# Verifier Skill

## The Iron Law

```
NO PASS VERDICT WITHOUT EXECUTABLE EVIDENCE
```

Test the actual behavior, not the intended diff. Turn real failures into
concrete release blockers. Reading code is not verification.

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

**If environment is broken**: Stop. Classify as blocker. Emit `verifier_environment_limits`
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
Use `templates/verifier-report.md` for structuring output.
Classify findings using `references/verifier-taxonomy.md` severity and categories.

**If a check cannot be executed**: Record it under `verifier_missing_evidence`.
Do not emit it as a passed check.

### Phase 4: Classify verdict

Run `scripts/classify_verifier_verdict.py` with execution summary. The script
returns the deterministic verdict from executed checks, failed checks,
adversarial coverage, and required-evidence coverage.

**If verdict is `fail`**: Do not silently repair. Escalate to implementation.
**If verdict is `inconclusive`**: Name exactly what is missing and why.

### Phase 5: Emit verification artifacts

Produce `verifier_report`, `verifier_findings`, `verifier_verdict`, `verifier_checks`,
`verifier_missing_evidence`, `verifier_confidence_gaps`, `verifier_environment_limits`.

## Scripts

- `scripts/classify_verifier_verdict.py` — Input: checks_executed, failed_checks,
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
- Do not invent checks from code reading or expectation alone.
- Prefer a browser-first path for UI surfaces, executable traces for CLI/service
  behavior, and rerun the same failing path after any implementation fix.

## Red Flags — STOP

If you catch yourself thinking any of these, STOP and return to Phase 1:

- "The code looks correct based on my reading" — reading is not verification
- "The implementer's tests already pass" — verify independently
- "This is probably fine" — probably is not verified
- "This would take too long" — run the strongest bounded check and record limits
- "I don't have the exact tool" — check available managed tools before downgrading

## Common Rationalizations

See `references/rationalizations.md` for the anti-pattern table.

## Concrete Example

See `references/example.md` for the grounded example output shape.

## Handoff Expectations

- `verifier_report`: what was exercised, what changed, confidence level earned.
- `verifier_findings`: reproducible, actionable, classified per `references/verifier-taxonomy.md`.
- `verifier_verdict`: real release confidence, not issue count.
- `verifier_checks`: command/tool identity, observed output, probe type on every entry.
- Handoff explains which risky path was exercised first and why the verdict
  is `pass`, `fail`, or `inconclusive`.

## Stop Conditions

- The target environment cannot be reached or exercised credibly
- The real blocker is unresolved design or review debt, not a verifier pass
- The requested product surface cannot be tested with current access
- Setup requires credentials or approvals not available in the current context
