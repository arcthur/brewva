# Debugging Strict Protocol (scaffold)

Failure mode this scaffold counters: under time pressure or after failed
fixes, models guess-and-patch, repeat an explanation without new evidence, or
rename a symptom as a cause.

Calibration posture: default-loaded until a same-experiment three-arm paired
evaluation records non-inferiority and the strong-tier ritual-cost check
supports demotion to on-demand.

## Rules

- `debugging.strict-active-hypothesis-cap` (adaptive-heuristic) — Default:
  keep at most three active hypotheses because each must retain a concrete
  falsification step; collapse a wider list to the cheapest discriminating
  probes.
- `debugging.strict-same-symptom-reset` (controlled-exception) — After two
  explanations reproduce the same symptom without new falsifying evidence,
  reset around the strongest remaining hypotheses before another attempt.
  Exception evidence: a named nondeterminism source that makes the repeated
  attempt a genuinely new sample.
- `debugging.strict-escalation-after-falsification` (controlled-exception) —
  After three falsified hypotheses on unchanged evidence, hand off the ranked
  investigation record instead of inventing another cause. Exception evidence:
  a newly observed signal or explicit operator approval to continue the bounded
  investigation.
- `debugging.strict-declared-probes-only` (controlled-exception) — A
  patch-shaped experiment declares its hypothesis, expected observation, and
  revert plan before execution. Exception evidence: an incident receipt showing
  an operator-approved emergency containment that is explicitly not claimed as
  causal confirmation.
- `debugging.strict-causal-claim-integrity` (non-negotiable) — Never label a
  symptom description, moved failure, or plausible mechanism as a confirmed
  root cause without the observation that excludes its live rivals.

## Advisory helper

Run `scripts/hypothesis_tracker.py` after a Phase 2 iteration when durable
externalization helps. It checks self-reported shape and reports neutral status
counts only; a non-zero exit means malformed shape, never that a count budget
was exceeded. It is not evidence and does not decide escalation.

## Common rationalizations

See `references/rationalizations.md` for the provenance-bearing inventory.
Unfired rows enter the calibration retirement watchlist instead of accumulating
forever.
