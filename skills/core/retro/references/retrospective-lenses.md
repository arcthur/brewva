# Retrospective Lenses

Use this reference when `retro` needs to separate useful lessons from generic
after-the-fact commentary.

## Lenses To Apply

- scope quality: was the wedge right-sized from the start?
- planning clarity: did the plan make implementation easier or force redesign?
- evidence quality: did review, verifier checks, and command-backed verification provide timely signal?
- release friction: what blocked merge, PR, or deploy readiness?
- repeatability: which pains are likely to happen again if nothing changes?

## Metrics-First Questions

- How many late blockers appeared after implementation started?
- Which stage produced the most churn: planning, review, verifier pass, or ship?
- Did evidence arrive early enough to avoid rework, or only after patch churn?
- Was the dominant pain local to this task or recurring across cycles?

## Good Retro Findings

Strong findings usually include:

- one concrete event or repeated pattern
- why it hurt delivery quality or confidence
- whether the issue was local or systemic
- one bounded follow-up that would reduce the same pain next time

## Anti-Patterns

- generic positivity with no operational lesson
- blame without a concrete improvement path
- broad rewrite proposals from one weak data point
