---
name: debugging
description: Use when tests or runtime behavior fail unexpectedly and causal confidence
  is needed before any code change.
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
    - skill_complete
references:
  - skills/meta/skill-authoring/references/authored-behavior.md
  - references/failure-triage.md
consumes:
  - repository_snapshot
  - impact_map
  - verification_evidence
  - runtime_trace
requires: []
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

### Phase 2: Rank hypotheses

Keep at most 3 active hypotheses. Run `scripts/hypothesis_tracker.py` to validate.
Falsify the strongest hypothesis first, not the easiest to patch.

If the failure looks like a regression, check recent history with `git-ops` patterns.
If it resembles a prior repo pattern, query the precedent layer.

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

## Scripts

- `scripts/hypothesis_tracker.py` — Input: hypotheses array with id/claim/status/evidence, optional max_active. Output: validation result with active_count and escalation signal. Run before and after each Phase 2 iteration.

## Decision Protocol

- What exact boundary or invariant fails first, not just most visibly?
- What condition must already be true for the observed symptom to appear?
- What earlier state transition or input created that condition?
- What single observation would falsify the current leading hypothesis?
- If the proposed cause were repaired, what downstream symptom disappears immediately?

## Red Flags — STOP

If you catch yourself thinking any of these, STOP and return to Phase 1:

- "Quick fix for now, investigate later"
- "Just try changing X and see if it works"
- "I don't fully understand but this might work"
- "One more fix attempt" (when already tried 2+)
- "It's probably X, let me fix that"
- Proposing solutions before tracing data flow
- Each fix reveals a new problem in a different place

## Common Rationalizations

| Excuse                                     | Reality                                                              |
| ------------------------------------------ | -------------------------------------------------------------------- |
| "Issue is simple, don't need process"      | Simple issues have root causes too. Process is fast for simple bugs. |
| "Emergency, no time for process"           | Systematic debugging is FASTER than guess-and-check thrashing.       |
| "Just try this first, then investigate"    | First fix sets the pattern. Do it right from the start.              |
| "I see the problem, let me fix it"         | Seeing symptoms ≠ understanding root cause.                          |
| "One more fix attempt" (after 2+ failures) | 3+ failures = architectural problem. Question the pattern.           |
| "Multiple fixes at once saves time"        | Cannot isolate what worked. Causes new bugs.                         |

## Concrete Example

Input: "Typecheck passes, but cascade events stop reconciling after session replay."

Output:

```json
{
  "root_cause": "ReplayService emits events with stale session epoch. CascadeReconciler skips events where epoch < current, causing silent drop after replay completes.",
  "fix_strategy": "Pin epoch to post-replay value in ReplayService.finalize(). Add epoch assertion in CascadeReconciler.accept().",
  "failure_evidence": "replay-session --id=abc123 completes; reconciler log shows 0 events processed; event dump shows epoch=3 vs current=5.",
  "investigation_record": {
    "hypotheses_tested": [
      {
        "id": 1,
        "claim": "Reconciler crash on malformed event",
        "status": "falsified",
        "evidence": "No error in event log; reconciler exits cleanly"
      },
      {
        "id": 2,
        "claim": "Event queue drained before reconciler starts",
        "status": "falsified",
        "evidence": "Queue depth=12 at reconciler start"
      },
      {
        "id": 3,
        "claim": "Stale epoch after replay",
        "status": "confirmed",
        "evidence": "Event epoch=3, current session epoch=5; reconciler skip branch hit"
      }
    ],
    "failed_attempts": [],
    "root_cause_boundary": "packages/brewva-runtime/src/services/replay.ts",
    "verification_linkage": "replay-session + reconciler log inspection"
  },
  "planning_posture": "moderate"
}
```

## Handoff Expectations

- `root_cause` names one dominant cause, the boundary where it lives, and why competing explanations were rejected.
- `fix_strategy` describes the smallest credible repair and the verification proving the repair.
- `failure_evidence` preserves commands, traces, and conditions so implementation can continue from the failing state.
- `investigation_record` keeps the debugging path replayable: hypotheses, evidence, disproof, final cause.
- `planning_posture` tells downstream planning whether the repair is local, bounded, or high-risk.

## Stop Conditions

- The issue cannot be reproduced with current information.
- Three ranked hypotheses are exhausted with no confirmed cause (`hypothesis_tracker.py` returns `should_escalate: true`).
- The real blocker is missing runtime or repository context that cannot be obtained.
