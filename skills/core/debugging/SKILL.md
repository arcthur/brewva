---
name: debugging
description: Root-cause investigation for failing tests or runtime behavior
  before patching.
stability: stable
selection:
  when_to_use: Use when tests or runtime behavior fail and the next step is to reproduce the problem, rank hypotheses, and confirm root cause before patching.
  examples:
    - Debug this regression before changing the code.
    - Find the root cause of this failing behavior.
    - Reproduce the bug and explain why it happens.
  phases:
    - investigate
    - execute
intent:
  outputs:
    - root_cause
    - fix_strategy
    - failure_evidence
    - investigation_record
    - planning_posture
  output_contracts:
    root_cause:
      kind: text
      min_words: 3
      min_length: 18
    fix_strategy:
      kind: text
      min_words: 3
      min_length: 18
    failure_evidence:
      kind: text
      min_words: 2
      min_length: 12
    investigation_record:
      kind: json
      min_keys: 5
    planning_posture:
      kind: enum
      values:
        - trivial
        - moderate
        - complex
        - high_risk
effects:
  allowed_effects:
    - workspace_read
    - local_exec
    - runtime_observe
  denied_effects:
    - workspace_write
resources:
  default_lease:
    max_tool_calls: 100
    max_tokens: 180000
  hard_ceiling:
    max_tool_calls: 140
    max_tokens: 240000
execution_hints:
  preferred_tools:
    - read
    - exec
    - grep
    - knowledge_search
  fallback_tools:
    - lsp_diagnostics
    - ast_grep_search
    - ledger_query
references:
  - references/failure-triage.md
  - references/example.md
  - references/rationalizations.md
consumes:
  - repository_snapshot
  - impact_map
  - verification_evidence
  - runtime_trace
scripts:
  - scripts/hypothesis_tracker.py
composable_with:
  - implementation
  - runtime-forensics
---

# Debugging

## The Iron Law

```
NO PATCH WITHOUT CONFIRMED ROOT CAUSE
```

## When to Use

- Tests or runtime behavior fail unexpectedly.
- A regression appears after recent changes.
- The team needs causal confidence before patching.
- Under time pressure — emergencies make guessing tempting.
- You already tried a fix and it did not work.

## When NOT to Use

- The problem is a known configuration gap with a documented remedy.
- The failure is in code you are about to delete entirely.
- Another skill already confirmed the root cause and handed you a `fix_strategy`.

## Workflow

### Phase 1: Reproduce the failure

Capture the failing command, first error line, and affected boundary.

**If not reproducible**: Stop. Record the gap in `investigation_record`. Do not guess.
**If reproducible**: Proceed to Phase 2.

Before Phase 2, write a one-sentence root-cause candidate in plain language.
This sentence is provisional, but it must name a mechanism, not a symptom.

### Phase 2: Rank hypotheses

Keep at most 3 active hypotheses. Run `scripts/hypothesis_tracker.py` to validate.
Falsify the strongest hypothesis first, not the easiest to patch.

If the failure looks like a regression, check recent history with `git` patterns.
If it resembles a prior repo pattern, query the precedent layer.

Use bisect mode when the symptom has a known-good baseline or a recent change
range. Bisect mode narrows the first bad commit, config change, or artifact
transition before proposing a repair.

**If tracker says `should_escalate`**: Stop. All hypotheses exhausted — escalate.
**If active hypotheses remain**: Proceed to Phase 3.

### Phase 3: Separate symptom from cause

Classify each observation as direct evidence, hypothesis, or speculation.
Identify the single explanation that fits the full signal.

**If no single explanation fits**: Return to Phase 2 with new hypotheses.
**If one explanation survives**: Proceed to Phase 4.

### Phase 4: Confirm and emit

Do not patch. Produce all five outputs:

- `root_cause`: single dominant cause and the boundary where it lives.
- `fix_strategy`: minimum valid repair and the verification needed.
- `failure_evidence`: commands, traces, observed conditions.
- `investigation_record`: hypotheses tested, evidence, disproving observations, final cause.
- `planning_posture`: `trivial` | `moderate` | `complex` | `high_risk`.

**If confirmation evidence is weak**: Return to Phase 1 with tighter reproduction.

Same-symptom hard stop: if two attempted explanations produce the same symptom
with no new falsifying evidence, stop and reset the investigation around the
three best hypotheses. Do not make a third patch-shaped guess.

## Scripts

- `scripts/hypothesis_tracker.py` — Input: hypotheses array with id/claim/status/evidence, optional max_active. Output: validation result with active_count and escalation signal. Run before and after each Phase 2 iteration.

## Decision Protocol

- What exact boundary or invariant fails first, not just most visibly?
- What condition must already be true for the observed symptom to appear?
- What earlier state transition or input created that condition?
- What single observation would falsify the current leading hypothesis?
- If the proposed cause were repaired, what downstream symptom disappears immediately?
- Can the root cause be stated in one sentence without reusing the symptom as
  the explanation?
- Is a bisect cheaper than another local inspection pass?

## Red Flags — STOP

If you catch yourself thinking any of these, STOP and return to Phase 1:

- "Quick fix for now, investigate later"
- "Just try changing X and see if it works"
- "I don't fully understand but this might work"
- "One more fix attempt" (when already tried 2+)
- "It's probably X, let me fix that"
- Proposing solutions before tracing data flow
- Each fix reveals a new problem in a different place
- Repeating the same symptom after two explanation attempts
- Root-cause text that says what failed but not why it failed

## Common Rationalizations

See `references/rationalizations.md` for the anti-pattern table.

## Concrete Example

See `references/example.md` for the grounded example output shape.

## Handoff Expectations

- `root_cause` names one dominant cause, the boundary where it lives, and why competing explanations were rejected.
- `fix_strategy` describes the smallest credible repair and the verification proving the repair.
- `failure_evidence` preserves commands, traces, and conditions so implementation can continue from the failing state.
- `investigation_record` keeps the debugging path replayable: hypotheses, evidence, disproof, final cause.
- `planning_posture` tells downstream planning whether the repair is local, bounded, or high-risk.
- If the repair is not obvious after confirmation, hand off the top three
  hypotheses and rejected explanations so `plan` or `implementation` does not
  restart from scratch.

## Stop Conditions

- The issue cannot be reproduced with current information.
- Three ranked hypotheses are exhausted with no confirmed cause (`hypothesis_tracker.py` returns `should_escalate: true`).
- The real blocker is missing runtime or repository context that cannot be obtained.
- The same symptom persists after two explanation attempts without new evidence.
