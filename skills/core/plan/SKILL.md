---
name: plan
description: Bounded planning for multi-approach, cross-boundary, or trade-off-heavy requests.
selection:
  when_to_use: Use when a request needs a bounded plan, explicit trade-offs, or an executable
    implementation path before code changes.
references:
  - references/executable-evidence-bridge.md
  - references/explorer-consultation-protocol.md
  - references/plan-output-template.md
  - references/example.md
  - references/rationalizations.md
invariants:
  - invariants/planning-posture.md
---

# Plan Skill

## The Iron Law

```
NO PLAN WITHOUT EXPLICIT TRADE-OFFS AND CHOSEN PATH
```

Every emitted plan names what was rejected and why.

## When to Use / When NOT to Use

- The task has multiple viable approaches
- A change crosses package or module boundaries

Do NOT use when:

- The change is a single-file, single-concern fix with no trade-offs
- The real work is debugging, not planning
- No planning decision actually exists

## Workflow

### Phase 0: Ground the working path

Confirm the current repository, package boundary, and requested target from
visible runtime context, tool metadata, and loaded paths before planning. If the
visible working path does not match the user's stated target, stop and surface
the mismatch instead of producing a portable plan for the wrong tree.

Prefer official or repository-native solutions first:

- Use existing docs, package contracts, and helper APIs before inventing an abstraction.
- If the task depends on a framework or public API and local evidence is not
  enough, consult the official source before choosing a path.
- Treat every fragile assumption as a named risk with an owner, mitigation, or
  blocking question.

### Question Escalation Rule

- If choosing a valid plan depends on a missing operator decision in the current turn, use the `question` tool.
- Do not hide a blocking missing decision inside prose, `risk_register`, or inherited `open_questions`.
- Treat consumed `open_questions` as carry-over context for non-blocking uncertainty, not as a substitute for live clarification.

### Phase 1: Classify planning posture

Classify posture with the rule set in `invariants/planning-posture.md`. This
skill is read-only and does not require local execution; use host-provided
posture output when already available, otherwise apply the invariant manually.
Use the posture to calibrate depth: `trivial` gets a lightweight plan,
`high_risk` gets full trade-off analysis and risk register.

If upstream `planning_posture` exists, reconcile it with the classifier result.
If they disagree, use the stricter posture and note the gap.

**If scope data is unavailable**: Default to `moderate`. Do not assume triviality.

### Phase 2: Compare approaches

Offer 1–3 materially different approaches with explicit trade-offs on ownership,
blast radius, migration/rollback cost, and verification strength. Choose one.

Attack the favored path:

- What breaks if the central assumption is wrong?
- Which boundary or persisted format would make rollback expensive?
- What simpler official or repo-native pattern would a reviewer expect instead?
- What fails under partial implementation or stale context?

**If all approaches violate hard constraints**: Stop. Report the constraint
conflict. Do not force a plan through broken constraints.

### Phase 3: Validate against precedent

Use retrieved repository precedents when they fit. If you deliberately diverge
from a consulted precedent, explain why the current case is materially different.

**If no precedent exists**: Proceed. Note the absence in the risk register.

### Phase 4: Force key decisions into the open

Make boundary ownership, migration posture, verification posture, rollback
assumptions, and preventive checks explicit. Every deferred decision must be named
as deferred and assigned to a downstream skill.

**If a key decision cannot be made and the current turn is blocked on operator input**: Use the `question` tool.
**If a key decision can be deferred safely**: Record the deferred boundary. Do
not paper over it with optimistic assumptions.

### Phase 5: Emit bounded artifacts

Produce `design_spec`, `execution_plan`, `execution_mode_hint`, `risk_register`, and
`implementation_targets`. Every artifact must reference concrete paths, not vague
areas. When the plan feeds a construction task, also emit the requirement atoms:
decompose the spec into `task_set_spec` atoms with a `riskClass` per known trap,
so implementation inherits the working set the ladder verifies against instead of
re-deriving it after the writes.

If the plan is a precursor to code, require an explicit approval or handoff
signal before implementation begins. Do not smuggle code edits into plan output.

## Invariants

- `invariants/planning-posture.md` — Canonical posture classifier rule set.
  Input: affected_paths_count, boundaries_crossed, has_public_surface,
  has_persisted_format, has_security_surface. Output: posture classification
  and reason. Use host-provided output when available; otherwise classify
  manually without crossing the read-only boundary.

## Decision Protocol

- Which boundary actually owns this change?
- Which option minimizes blast radius without weakening the outcome?
- What verification evidence would prove this path was the right one?
- What was rejected, and would a downstream reader agree with the rejection?
- Which fragile assumption would change the plan if false?

## Red Flags — STOP

If you catch yourself thinking any of these, STOP and return to Phase 2:

- "There's really only one way to do this" — without proving alternatives are worse
- "The trade-offs are obvious" — without writing them down
- "This is trivial" — when posture classification says otherwise
- "I'll figure out the rollback story later"
- "The boundary question doesn't matter for this change"

## Concrete Example

See `references/example.md` for the grounded example output shape.

## Handoff Expectations

- `design_spec`: scope, owning modules, hard constraints, and reused or rejected
  precedents.
- `execution_plan`: ordered and verification-aware. Preserve `step`, `intent`,
  `owner`, `exit_criteria`, and `verification_intent`.
- `execution_mode_hint`: choose direct patch, test-first, or coordinated rollout.
- `risk_register`: every risk includes `risk`, `category`, `severity`,
  `mitigation`, `required_evidence`, and `owner_lane`.
- `implementation_targets`: path-scoped targets with `target`, `kind`,
  `owner_boundary`, and `reason`; never string-only placeholders.

## Stop Conditions

- A critical requirement is missing and changes the primary architecture choice
- All viable options violate hard constraints
- The real blocker is lack of repository understanding, not lack of planning
