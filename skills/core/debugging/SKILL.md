---
name: debugging
description: Root-cause investigation for failing tests or runtime behavior before patching.
selection:
  when_to_use:
    Use when tests or runtime behavior fail and the next step is to reproduce the problem,
    rank hypotheses, and confirm root cause before patching.
references:
  - references/failure-triage.md
  - references/strict-protocol.md
  - references/example.md
  - references/rationalizations.md
scripts:
  - scripts/hypothesis_tracker.py
---

# Debugging

## The Iron Law

```
NO SHIPPED FIX WITHOUT CONFIRMED ROOT CAUSE — PROBES ARE LEGAL: DECLARE THE
HYPOTHESIS AND EXPECTED OBSERVATION, REVERT AFTER
```

A probe is a controlled experiment: a reversible change made to falsify a
declared hypothesis, observed, then reverted. A shipped fix is a change you
intend to keep. The law binds the second, never the first — in a cheaply
reversible workspace, intervention is often the strongest causal instrument
available.

## When to Use

- Tests or runtime behavior fail unexpectedly.
- A regression appears after recent changes.
- The team needs causal confidence before patching.
- You already tried a fix and it did not work.

## When NOT to Use

- The problem is a known configuration gap with a documented remedy.
- The failure is in code you are about to delete entirely.
- Another skill already confirmed the root cause and handed you a `fix_strategy`.

## Workflow

<!-- self-eval-strict-scaffold:start -->

Until a recorded paired-calibration verdict demotes it, load
`references/strict-protocol.md` before Phase 1 and follow its tightened rules.

<!-- self-eval-strict-scaffold:end -->

### Phase 1: Reproduce or bound the failure

Capture the failing command, first error line, and affected boundary.

**If reproducible**: Proceed to Phase 2 with the reproduction as your probe
bench.
**If not reproducible**: Do not stop — switch to evidence-limited
investigation: add instrumentation on the suspected path, contain the blast
radius if the failure is live, and work from recorded evidence (event tape,
logs, git history, prior traces). Record the reproduction gap in
`investigation_record`; a cause confirmed only from recorded evidence is
stated with that caveat, never upgraded silently.

Before Phase 2, write a one-sentence root-cause candidate in plain language.
This sentence is provisional, but it must name a mechanism, not a symptom.

### Phase 2: Rank hypotheses and falsify

Keep every active hypothesis falsifiable: each one carries its evidence
status and the next observation (or probe) that would falsify it. Falsify
the strongest hypothesis first, not the easiest to patch.

If the failure looks like a regression, bisect: a known-good baseline plus a
change range narrows the first bad commit or config transition faster than
local inspection. If it resembles a prior repo pattern, query the precedent
layer.

`scripts/hypothesis_tracker.py` is available as an advisory format lint for
externalizing the hypothesis list; its output is never evidence and never
decides escalation.

**If a new attempt would not be informed by anything new from the last one**:
Stop generating variants. Widen evidence instead — instrument, bisect, or
hand off with the ranked hypotheses.

### Phase 3: Separate symptom from cause

Classify each observation as direct evidence, hypothesis, or speculation.
Identify the smallest set of causes that explains the full signal — compound
failures are real; do not force one explanation onto two independent defects.

**If no candidate set explains the full signal**: Return to Phase 2 with the
unexplained residue as the new falsification target.
**If a candidate set survives**: Proceed to Phase 4.

### Phase 4: Confirm and emit

Confirm causally — a probe whose predicted observation comes true, or
recorded evidence that excludes every rival — then emit all five outputs:

- `root_cause`: the confirmed cause set and the boundary where it lives.
- `fix_strategy`: minimum valid repair and the verification needed.
- `failure_evidence`: commands, traces, observed conditions.
- `investigation_record`: hypotheses tested, evidence, disproving
  observations, probes run (with their declared expectations), final cause.
- `planning_posture`: `trivial` | `moderate` | `complex` | `high_risk`.

The fix itself belongs to `implementation`; hand off rather than widening
this skill into the patch.

**If confirmation evidence is weak**: Say so — emit with the confidence
caveat or return to Phase 2. Do not dress a plausible story as a confirmed
cause.

## Rules

- `debugging.confirmed-cause-before-shipped-fix` (controlled-exception) — No
  shipped fix without a confirmed root cause. Exception evidence: a probe
  receipt (declared hypothesis, expected observation, revert plan) recorded
  in `investigation_record`, or explicit operator approval for a mitigation
  shipped ahead of the cause.
- `debugging.no-fabricated-evidence` (non-negotiable) — Never present
  speculation or an unrun check as an observed fact; every claimed
  observation names how it was observed.
- `debugging.fresh-evidence-per-attempt` (controlled-exception) — A repeated
  attempt must be informed by new evidence from the last one. Exception
  evidence: a named nondeterminism source that makes the same attempt a new
  sample (timing race, environment reset).
- `debugging.active-hypothesis-count` (adaptive-heuristic) — Default: as many
  active hypotheses as you can name a next falsification step for; prune the
  ones you cannot.

## Scripts

- `scripts/hypothesis_tracker.py` — Advisory format lint over the
  self-reported hypothesis list (ids, statuses, evidence fields present).
  It reports neutral active/falsified/confirmed counts and exits non-zero only
  for malformed input shape. Useful for externalizing state across long
  sessions; its input is the model's own report, so its output is never
  independent evidence, never a phase gate, and never an escalation authority.

## Decision Protocol

- What exact boundary or invariant fails first, not just most visibly?
- What condition must already be true for the observed symptom to appear?
- What earlier state transition or input created that condition?
- What single observation would falsify the current leading hypothesis?
- What is the cheapest probe that discriminates between the top two
  hypotheses — and what exactly do I expect to see in each case?
- Can the root cause be stated in one sentence without reusing the symptom
  as the explanation?
- Is a bisect cheaper than another local inspection pass?
- If reproduction is impossible, which recorded evidence (tape, logs,
  history) bounds the cause best?

## Concrete Example

See `references/example.md` for the grounded example output shape.

## Handoff Expectations

- `root_cause` names the confirmed cause set, the boundary where it lives,
  and why competing explanations were rejected.
- `fix_strategy` describes the smallest credible repair and the verification
  proving the repair.
- `failure_evidence` preserves commands, traces, and conditions so
  implementation can continue from the failing state.
- `investigation_record` keeps the debugging path replayable: hypotheses,
  evidence, probes with declared expectations, disproof, final cause — and
  the reproduction gap when the investigation was evidence-limited.
- `planning_posture` tells downstream planning whether the repair is local,
  bounded, or high-risk.
- If the repair is not obvious after confirmation, hand off the top ranked
  hypotheses and rejected explanations so `plan` or `implementation` does
  not restart from scratch.

## Stop Conditions

- The cause is confirmed and the fix belongs to `implementation`.
- Reproduction is impossible AND recorded evidence (tape, logs, history,
  instrumentation) is exhausted without a surviving explanation — hand off
  the ranked hypotheses and the evidence gap.
- The real blocker is missing runtime or repository context that cannot be
  obtained from the current environment.
- New attempts have stopped being informed by new evidence and further
  instrumentation is outside this session's reach.
