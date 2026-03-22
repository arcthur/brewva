# Stuck Signals Reference

Load this reference when `self-improve` needs help deciding whether repeated
loop behavior is strong enough to justify a system lesson.

## Evidence Threshold

One stuck event is not yet a system lesson.

You need a bounded evidence set that shows repetition, for example:

- multiple flat or regressing metric outcomes with the same reason family
- repeated guard failures around otherwise similar metric movement
- repeated handoff or convergence reports that keep saying `continue` or
  `escalated` without meaningful trajectory change
- repeated user or operator intervention on the same protocol weakness

## Signal Families

### Flat Or Regressing Streak

Treat this as meaningful when several consecutive iterations show no meaningful
progress for closely related reasons such as:

- `no_improvement`
- `below_noise_floor`
- repeated strategy mismatch

Likely routing:

- `goal-loop` protocol tightening when the issue is fact discipline or loop
  setup
- `design` guidance when the loop is pursuing the wrong wedge
- targeted tooling when the same measurement or verification step keeps failing

### Guard Flakiness

Treat this as meaningful when guard outcomes alternate between `pass`, `fail`,
or `inconclusive` without a strong accompanying change in the main metric.

Likely routing:

- verification guidance when the guard itself is weak
- runtime or observability docs when evidence collection is unstable
- design or implementation follow-up when the loop is optimizing a brittle path

### Convergence Stall

Treat this as meaningful when repeated runs keep landing in `continue` while
the underlying metric trajectory stays flat or remains below the declared
minimum delta.

Likely routing:

- `goal-loop` contract guidance when convergence predicates or cadence are too
  weak
- `design` when the loop is trapped in a low-leverage local optimum
- `predict-review` when competing explanations are needed before another run

### Repeated Escalation

Treat this as meaningful when runs repeatedly end in `escalated` or `blocked`,
especially when the trigger is the same missing contract, missing ownership
boundary, or missing evidence source.

Likely routing:

- skill authored-behavior or handoff rules when ownership is the failure mode
- shared project rules when the same missing prerequisite recurs across skills
- runtime or tool docs when operator boundaries are repeatedly misunderstood

## Claim Discipline

- Keep evidence, hypothesis, and remediation separate.
- No claim without concrete fact references, report ids, or evidence anchors.
- No broad remediation when the evidence set is narrow.
- Prefer the smallest durable fix that reduces future repeat cost.
