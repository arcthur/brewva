# Premise And Alternatives Reference

Use this reference after `office-hours` has enough context to stop interviewing
and start judging the idea.

## Premise Challenge

Challenge the idea before designing it:

- Is this the right problem, or is it a proxy for another pain?
- What happens if nobody builds this?
- What existing behavior, code, tool, script, or team process partially solves
  it?
- Which assumption would kill the idea if false?
- What evidence would change the recommendation?
- If this creates an artifact, how will users receive it, share it, reuse it,
  or run it again?

Do not bury a weak premise under execution detail. If the premise is weak, the
next assignment should gather evidence, watch behavior, interview a specific
person, produce a mock artifact, or test distribution.

## Approach Options

Produce two or three distinct approaches:

1. Minimal viable path
   - the smallest test that could change the recommendation
   - usually read-only, manual, mock, prototype, or single-surface
   - optimized for evidence or a showable artifact
2. Ideal architecture or fullest-value path
   - the coherent version if the premise is right
   - names the durable product or system shape without pretending it is v1
   - identifies what must be deferred
3. Creative or lateral path
   - optional when reframing creates leverage
   - changes audience, output format, distribution, or delight mechanism
   - useful for builder mode and for startup ideas stuck in a crowded frame

Each option should include:

- what it tests or proves
- why it might win
- why it might fail
- the cheapest next evidence
- the natural downstream owner if selected

## Recommendation Rules

- Recommend one path when the evidence clearly favors it.
- Recommend evidence gathering when all paths rest on the same untested
  assumption.
- Recommend stopping or reframing when the status quo is too strong, the target
  human is too vague, or distribution is ignored.
- Do not recommend implementation until the user selects a path and the next
  build boundary is concrete.

## Handoff Rules

- Handoff to `discovery` when the idea is plausible but the product/request
  frame needs sharper user pain, non-goals, and a plan-ready seed.
- Handoff to `strategy` when the wedge is plausible and the decision is now
  timing, scope posture, sequencing, or leverage.
- Handoff to `architecture` when the selected path is an existing-codebase
  deepening opportunity.
- Handoff to `plan` only after approach selection and scope boundary are
  explicit.
