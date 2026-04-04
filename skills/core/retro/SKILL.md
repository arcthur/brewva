---
name: retro
description: Distill a delivery cycle into concrete lessons, recurring friction, and
  next-step improvements after the work has been shipped or blocked.
stability: stable
selection:
  when_to_use: Use when a completed or blocked delivery cycle should be distilled into concrete lessons, repeated friction, and next-step improvements.
  examples:
    - Run a retro on this delivery cycle.
    - Capture what slowed this rollout down.
    - Name the recurring waste before the next iteration.
  phases:
    - blocked
    - done
intent:
  outputs:
    - retro_summary
    - retro_findings
    - followup_recommendation
  output_contracts:
    retro_summary:
      kind: text
      min_words: 3
      min_length: 18
    retro_findings:
      kind: json
      min_items: 1
    followup_recommendation:
      kind: text
      min_words: 3
      min_length: 18
effects:
  allowed_effects:
    - workspace_read
    - local_exec
    - runtime_observe
  denied_effects:
    - workspace_write
resources:
  default_lease:
    max_tool_calls: 80
    max_tokens: 150000
  hard_ceiling:
    max_tool_calls: 120
    max_tokens: 210000
execution_hints:
  preferred_tools:
    - read
    - exec
    - workflow_status
  fallback_tools:
    - ledger_query
    - tape_search
    - skill_complete
references:
  - skills/meta/skill-authoring/references/authored-behavior.md
  - references/retrospective-lenses.md
consumes:
  - ship_report
  - release_checklist
  - ship_decision
  - qa_report
  - review_report
  - verification_evidence
requires: []
---

# Retro Skill

## Intent

Turn one delivery cycle into explicit lessons and follow-up bets instead of
letting hard-won signal evaporate after shipping.

## Trigger

Use this skill when:

- a feature, fix, or rollout has just shipped or been blocked
- the team wants to capture lessons from review, QA, and release friction
- repeated delivery waste needs to be named before the next cycle begins

## Workflow

### Step 1: Collect the measurable delivery facts

Start with the concrete arc: scope decision, review outcome, QA verdict,
verification result, ship decision, notable blockers, and the rough change
surface if it matters.

### Step 2: Reconstruct the delivery arc

Summarize the intended work, what actually happened, and where time or certainty
was lost.

### Step 3: Distill concrete findings

Identify what helped, what failed, and which problems were local versus systemic.

### Step 4: Emit retrospective artifacts

Produce:

- `retro_summary`: the delivery arc and the most important takeaway
- `retro_findings`: ranked lessons, frictions, or repeated failure signals
- `followup_recommendation`: the next bounded improvement or experiment

## Interaction Protocol

- Ask only when the delivery target or evidence set is too incomplete to justify
  a credible retrospective.
- Be metrics-first where possible: prefer counts, concrete events, and named
  hotspots over generic prose about the team's experience.
- Re-ground on what actually shipped, what got blocked, and which evidence
  supports the lesson before naming a process conclusion.
- Recommend one primary follow-up rather than a vague bucket of "things to
  improve."

## Retrospective Questions

Use these questions to keep retro grounded in evidence:

- What specific moment created the most avoidable delay or uncertainty?
- Which problem was local noise versus a repeated pattern?
- What changed behavior or confidence for the better, and why?
- What is the smallest follow-up that would prevent this exact waste next time?

## Retrospective Protocol

- Start with measurable facts: what changed, what blocked, what had to be fixed
  late, and which stages consumed the most attention.
- Name hotspots explicitly: weak scope call, redesign churn, stale review,
  brittle QA, or release friction.
- Separate one-off pain from repeated or systemic friction.
- Prefer lessons that change future delivery quality, not generic morale
  commentary.
- Tie every finding back to concrete evidence from review, QA, release, or
  verification.
- If a finding is truly systemic, point toward `self-improve`; otherwise keep
  the follow-up bounded to the local workflow.

## Follow-Up Gate

- [ ] The top lesson is backed by concrete delivery evidence.
- [ ] One-off pain is separated from systemic friction.
- [ ] The recommended follow-up is bounded enough to execute in one next cycle.

## Handoff Expectations

- `retro_summary` should explain the delivery arc well enough that a future
  reader understands what was attempted and what mattered.
- `retro_findings` should rank meaningful lessons, not just list events.
- `followup_recommendation` should identify the single best next improvement,
  with a clear owner or destination if the work belongs in `self-improve`.

## Stop Conditions

- the delivery cycle is still in flight
- there is not enough concrete evidence to justify a retrospective
- the real need is live debugging or shipping, not reflection

## Anti-Patterns

- calling every blocked task a systemic lesson
- writing a retrospective with no specific evidence
- turning retro into broad organizational theory
- ending with many vague ideas instead of one bounded follow-up

## Example

Input: "We shipped the workflow advisory feature; summarize what slowed us down and what to fix next time."

Output: `retro_summary`, `retro_findings`, `followup_recommendation`.
