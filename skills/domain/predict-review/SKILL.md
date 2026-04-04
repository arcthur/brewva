---
name: predict-review
description: Advisory multi-perspective review using structured delegation, explicit
  anti-herd checks, and ranked hypotheses.
stability: experimental
selection:
  when_to_use: Use when a hard problem needs multi-perspective advisory review and explicit disagreement before choosing the next action.
  examples:
    - Give me multiple competing explanations for this issue.
    - Run a multi-perspective review before we act.
    - Surface disagreement across architecture, reliability, and performance views.
  phases:
    - investigate
    - verify
intent:
  outputs:
    - perspective_findings
    - debate_summary
    - ranked_hypotheses
  output_contracts:
    perspective_findings:
      kind: json
      min_items: 1
    debate_summary:
      kind: json
      min_items: 3
    ranked_hypotheses:
      kind: json
      min_items: 1
effects:
  allowed_effects:
    - workspace_read
    - runtime_observe
  denied_effects:
    - workspace_write
    - local_exec
resources:
  default_lease:
    max_tool_calls: 90
    max_tokens: 170000
  hard_ceiling:
    max_tool_calls: 130
    max_tokens: 230000
execution_hints:
  preferred_tools:
    - read
    - subagent_fanout
  fallback_tools:
    - subagent_run
    - read_spans
    - grep
    - task_view_state
    - skill_complete
references:
  - skills/meta/skill-authoring/references/authored-behavior.md
  - references/perspectives.md
consumes:
  - design_spec
  - change_set
  - review_report
  - verification_evidence
  - runtime_trace
requires: []
---

# Predict Review Skill

## Intent

Generate competing, evidence-backed hypotheses from multiple perspectives
before `debugging`, `design`, `review`, or `goal-loop` commits to the next
move.

This skill is advisory only. It strengthens judgment; it does not create
runtime authority, bypass verification, or cross the proposal boundary.

## Trigger

Use this skill when:

- a complex problem has multiple plausible explanations
- a one-pass review is likely to miss architectural, security, reliability, or
  performance trade-offs
- the team needs explicit disagreement surfaced before choosing the next owner
- a bounded loop keeps failing and needs competing explanations before another
  run

Do not use this skill when:

- the next step is already obvious and low risk
- there is no concrete target to analyze
- the work needs immediate implementation rather than read-only judgment

## Workflow

### Step 1: Frame the review target

Name the exact target, scope, and decision the debate is meant to inform.

Typical outputs of this step:

- the code or design slice under review
- the concrete question to answer
- the likely downstream owner: `debugging`, `design`, `review`, or `goal-loop`

### Step 2: Run independent first-pass analysis

Use `subagent_fanout` when the perspectives can run independently.

Perspective-to-profile mapping:

| Perspective                  | Built-in agent spec  | Use                                                               |
| ---------------------------- | -------------------- | ----------------------------------------------------------------- |
| Architecture Reviewer        | `review-boundaries`  | boundary integrity, coupling, and contract drift                  |
| Security Analyst             | `review-security`    | exposure, trust, and misuse paths                                 |
| Reliability Engineer         | `review-operability` | failure handling, retries, edge conditions, and operator burden   |
| Performance Engineer         | `review-performance` | hot spots, scaling, and measurable regressions                    |
| Devil's Advocate             | `explore`            | alternative explanations, missing context, and anti-herd pressure |
| Optional empirical follow-up | `qa`                 | executable follow-up against the live risk surface                |

The perspective lives in the delegation packet:

- `objective`
- `sharedNotes`
- required output shape

When ordering, replay, or state-transition risk dominates, prefer
`review-concurrency` over `review-operability`. When public-surface or format
drift dominates, prefer `review-compatibility`.

### Step 3: Force structured challenge

Independent analysis happens first. Debate happens second.

Require all of the following:

1. Each perspective states its primary claim and strongest evidence.
2. Each perspective names at least one uncertainty or evidence gap.
3. The Devil's Advocate challenges majority positions explicitly.
4. Majority agreement is not enough on its own; unresolved objections must stay
   visible.
5. Use `subagent_run` for an optional QA pass when the debate needs executable
   confirmation or a targeted attempt to break the leading hypothesis.

### Step 4: Emit advisory artifacts

Produce:

- `perspective_findings`: perspective-by-perspective claims, evidence, and
  disagreements
- `debate_summary`: converged points, unresolved conflicts, and missing
  evidence
- `ranked_hypotheses`: ordered next hypotheses or failure explanations for the
  downstream owner

## Interaction Protocol

- Ask only when the review target, decision to inform, or downstream owner is
  too vague to make the debate useful.
- Re-ground every perspective in the same concrete scope. If the participants
  are debating different problems, restart with a tighter target.
- Prefer one strong debate packet over a large number of shallow delegated
  runs.

## Debate Setup Gate

- [ ] The review target is bounded.
- [ ] The decision the debate should inform is explicit.
- [ ] Each perspective has a distinct reason to exist.
- [ ] There is enough existing evidence to support read-only judgment.

## Debate Questions

Use these questions to keep the multi-perspective pass honest:

- What is the strongest claim each perspective can actually support?
- What evidence gap, if closed, would most likely reorder the hypotheses?
- What is the strongest challenge to the emerging majority view?
- Which disagreement is substantive enough that downstream work must see it?

## Delegation Protocol

- `subagent_fanout` is the default when the perspectives are independent.
- `subagent_run` is for a follow-up challenge or QA pass, not a
  replacement for the initial independent sweep.
- Keep all delegated runs read-only.
- Require each perspective packet to return concrete claims, evidence anchors,
  and confidence rather than free-form brainstorming.

## Debate Protocol

- Independent analysis must precede synthesis.
- Consensus is advisory evidence, not authority.
- Security, reliability, and performance concerns should not be collapsed into
  one generic "risk" bucket before their strongest claims are compared.
- If two perspectives disagree materially, preserve the disagreement in the
  output instead of smoothing it away.

## Anti-Herd Protocol

- When a majority position forms, record the strongest challenge against it.
- The Devil's Advocate must challenge at least one high-confidence or
  majority-backed claim.
- Ranked hypotheses must show why the top item won, what evidence still argues
  against it, and what evidence would falsify it.

## Handoff Expectations

- `perspective_findings` should identify the perspective, mapped profile,
  primary claim, evidence, open questions, and conflicts.
- `debate_summary` should separate converged claims, unresolved disagreements,
  and missing evidence that blocks confidence.
- `ranked_hypotheses` should be actionable by the next owner, with explicit
  rationale and recommended validation steps.

## Stop Conditions

- there is no bounded review target
- the debate would only restate one obvious conclusion
- required evidence is missing and no useful advisory judgment can be made

## Anti-Patterns

- treating delegated consensus as runtime authority
- writing code or issuing effectful actions inside the debate
- using removed legacy profile aliases instead of real built-in agent specs
- smoothing away disagreements to make the output look cleaner than the
  evidence supports

## Example

Input: "Before we run another bounded optimization pass, use multiple
perspectives to predict why the metric keeps stalling."

Output: `perspective_findings`, `debate_summary`, `ranked_hypotheses`.
