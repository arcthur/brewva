---
name: office-hours
description: Diagnose new product, feature, startup, side-project, hackathon, open-source, learning,
  or "worth building" ideas before planning or code.
selection:
  when_to_use: Use when a new idea or "is this worth building" question needs diagnosis before
    discovery, strategy, planning, or implementation.
references:
  - references/startup-diagnostic.md
  - references/builder-mode.md
  - references/premise-and-alternatives.md
  - references/example.md
  - references/rationalizations.md
---

# Office-Hours Skill

## The Iron Law

```
NO OFFICE HOURS WITHOUT MODE, PREMISES, AND A NEXT ASSIGNMENT
```

## When to Use / When NOT to Use

Use when:

- the user brings a new product, startup, feature, side-project, hackathon,
  open-source, learning, or fun build idea before planning
- the key question is "is this worth building?", "what is the wedge?", "who
  would care?", or "what is the coolest version?"
- the task needs idea diagnosis, demand reality, delight direction, or premise
  challenge before repository or execution planning

Do NOT use when:

- the request is an existing repo or product task with unclear pain or scope
  (use `discovery`)
- the wedge already exists and the question is timing, sequencing, or scope
  posture (use `strategy`)
- the user already chose the direction and needs a detailed implementation plan
  (use `plan`)
- the task is architecture deepening inside an existing codebase (use
  `architecture`)
- the user asks for UI-specific visual direction (use `frontend-design`)

## Workflow

### Question Escalation Rule

- Ask one question at a time when an answer changes the diagnosis materially.
- Stop after each blocking question. Do not bundle a questionnaire.
- Smart-skip questions already answered by the prompt, repo, or prior artifacts.
- If the user is impatient, give a provisional recommendation and one sharp next
  assignment instead of forcing the full interview.

### Phase 1: Classify mode and maturity

Decide whether the idea is a startup/intrapreneurship bet or a builder project.
Startup mode optimizes for demand reality and narrow wedges. Builder mode
optimizes for delight, showable artifacts, and creative adjacent unlocks.

**If the prompt is an existing repo/product request rather than a new idea**:
Hand off to `discovery`.
**If the wedge is already specific and the open issue is scope or timing**:
Hand off to `strategy`.
**If mode is ambiguous but a provisional path is possible**: Pick the higher-risk
miss and record the ambiguity in `premise_challenge`.
**If mode is clear**: Proceed to Phase 2.

### Phase 2: Interview with discipline

Use `references/startup-diagnostic.md` or `references/builder-mode.md`. Ask
only the highest-leverage unanswered question.

**If startup demand, status quo, or specific user blocks diagnosis**: Ask one
question and stop.
**If builder delight, showable artifact, or audience blocks diagnosis**: Ask one
question and stop.
**If evidence supports a provisional recommendation**: Proceed to Phase 3.

### Phase 3: Challenge the premise

Use `references/premise-and-alternatives.md` to challenge problem fit, status
quo, partial existing solutions, and distribution.

**If the premise collapses under status quo or distribution pressure**: Say so
directly and make the next assignment evidence-gathering, not building.
**If plausible but underspecified**: Preserve the gap in `premise_challenge`.
**If the premise is strong enough to compare paths**: Proceed to Phase 4.

### Phase 4: Generate approaches without implementation

Produce two or three approaches: minimal viable path, ideal/fullest-value path,
and a creative/lateral path when reframing would help.

**If all options are implementation steps for the same idea**: Stop and return
to premise work. Office-hours compares bets, not task lists.
**If an option needs code to validate**: Convert it into a no-code assignment or
handoff to `plan` after the user selects it.
**If options expose a clear recommendation**: Proceed to Phase 5.

### Phase 5: Emit office-hours artifacts

Produce `office_hours_brief`, `mode_decision`, `premise_challenge`,
`approach_options`, and `next_assignment`.

**If the brief does not name the target human or showable artifact**: Return to
Phase 2.
**If the next assignment is "build it" without evidence or selection**: Return
to Phase 3.
**If artifacts are concrete and no code was produced**: Hand off explicitly.

## Decision Protocol

- Is this startup mode or builder mode?
- Who is the specific human, not the demographic label?
- What is the status quo, workaround, or current alternative?
- What is the narrowest wedge that could still change reality?
- What is the coolest version someone would want to show another person?
- What evidence would change the recommendation?

## Red Flags - STOP

If you catch yourself thinking any of these, STOP and return to Phase 1:

- "This is interesting, so it is worth building"
- "The user is excited, so demand exists"
- "Everyone could use this"
- "Let's plan implementation before naming the specific human"
- "I'll be encouraging now and ask hard questions later"

## Common Rationalizations

See `references/rationalizations.md` for the anti-pattern table.

## Concrete Example

See `references/example.md` for the grounded example output shape.

## Handoff Expectations

- `office_hours_brief` states the mode, target human or audience, status quo,
  core premise, and recommended posture.
- `premise_challenge` records the strongest objections, missing evidence, and
  what would change the recommendation.
- `approach_options` compares distinct bets, including minimal viable and ideal
  paths, not merely implementation phases.
- `next_assignment` is structured JSON with `type`, `assignment`, and
  `evidence_target`; it names the smallest useful pre-code task.
- Handoff to `discovery` when an idea becomes an existing product request.
- Handoff to `strategy` when the wedge is plausible and scope or timing now
  needs pressure.
- Handoff to `plan` only after the user selects an approach and the build
  boundary is concrete.

## Stop Conditions

- The user asks for code, patching, scaffolding, or implementation instead of
  idea diagnosis.
- The prompt already has a clear wedge and only needs scope/timing judgment.
- The premise still lacks a specific human, artifact, status quo, or audience
  after one focused follow-up.
- Continuing requires unavailable market research, browser work, or interviews.
