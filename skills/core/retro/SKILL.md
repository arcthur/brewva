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

## The Iron Law

```
NO SYSTEMIC LESSON WITHOUT CONCRETE DELIVERY EVIDENCE
```

Violating the letter of this rule is violating the spirit of this rule.

## When to Use / When NOT to Use

Use when:

- a feature, fix, or rollout has just shipped or been blocked
- the team wants to capture lessons from review, QA, and release friction
- repeated delivery waste needs to be named before the next cycle begins

Do NOT use when:

- the delivery cycle is still in flight (wait for a terminal state)
- the real need is live debugging or shipping, not reflection (use `debugging` or `implementation`)
- there is no concrete evidence to justify a retrospective (no ship report, no review report, no QA data)

## Workflow

### Phase 1: Collect measurable delivery facts

Gather the concrete arc: scope decision, review outcome, QA verdict, verification result, ship decision, notable blockers, and change surface.

**If source artifacts (ship_report, review_report, qa_report) are missing**: Stop. Record what is unavailable. Do not fabricate delivery facts from memory.
**If facts are available**: Proceed to Phase 2.

### Phase 2: Reconstruct the delivery arc

Summarize the intended work, what actually happened, and where time or certainty was lost.

**If the arc is too fragmented to trace cause and effect**: Record the gap. Produce a partial `retro_summary` noting insufficient evidence. Do not invent a coherent narrative.
**If arc is traceable**: Proceed to Phase 3.

### Phase 3: Distill findings with evidence

Identify what helped, what failed, and whether each problem was local or systemic. Every finding must cite a concrete delivery event.

**If a finding has no backing evidence**: Drop it. Do not include unsupported lessons.
**If findings are grounded**: Proceed to Phase 4.

### Phase 4: Emit retrospective artifacts

Produce `retro_summary`, `retro_findings`, and `followup_recommendation`.

**If the recommendation is a vague bucket of improvements rather than one bounded action**: Return to Phase 3 and sharpen.
**If artifacts are concrete**: Hand off to downstream skills.

## Decision Protocol

- What specific moment created the most avoidable delay or uncertainty?
- Which problem was local noise versus a repeated pattern across cycles?
- What changed behavior or confidence for the better, and what evidence shows that?
- What is the smallest follow-up that would prevent this exact waste next time?
- Is this finding truly systemic (route to `self-improve`) or local to this cycle?

## Red Flags — STOP

If you catch yourself thinking any of these, STOP and return to Phase 1:

- "This blocker was probably systemic" (without evidence from prior cycles)
- "The whole process needs rethinking" (without naming a specific failure)
- "I'll list everything that went wrong"
- "The team should communicate better" (generic, no concrete event)
- "This retro is obvious, I don't need the source artifacts"

## Common Rationalizations

| Excuse                                                 | Reality                                                                             |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| "Every blocker is a systemic lesson"                   | Most blockers are local. Systemic requires evidence across cycles.                  |
| "I remember what happened, I don't need the artifacts" | Memory is not evidence. Typed artifacts are the source of truth.                    |
| "More findings means a more thorough retro"            | Ungrounded findings dilute the signal. Fewer, backed findings are better.           |
| "A broad recommendation covers more ground"            | A broad recommendation changes nothing. One bounded action is worth ten vague ones. |

## Concrete Example

Input: "We shipped the workflow advisory feature; summarize what slowed us down and what to fix next time."

Output:

```json
{
  "retro_summary": "Workflow advisory shipped after a 3-day delay. Scope was right-sized but review surfaced two missed boundary crossings (runtime→gateway event contract, gateway→CLI help text). QA caught a regression in the fallback path that required a second implementation pass. The primary lesson is that boundary-crossing changes need explicit contract checks before review, not during it.",
  "retro_findings": [
    {
      "finding": "Missed runtime→gateway event contract change",
      "type": "systemic",
      "evidence": "review_report flagged EventPayload shape mismatch; same class of miss occurred in the prior ingress rollout",
      "impact": "2-day review loop to resolve contract alignment"
    },
    {
      "finding": "Fallback path regression caught in QA, not in unit tests",
      "type": "local",
      "evidence": "qa_report: fallback handler returned stale advisory after session replay",
      "impact": "1-day rework; added targeted regression test"
    },
    {
      "finding": "Scope decision held correctly — no creep during implementation",
      "type": "positive",
      "evidence": "ship_report scope matches original scope_decision exactly",
      "impact": "Avoided the scope drag seen in the previous cycle"
    }
  ],
  "followup_recommendation": "Add a pre-review boundary contract check to the implementation skill workflow. When the impact_map shows cross-package boundaries, require explicit contract verification before entering review. Route the systemic finding to self-improve for process-level encoding."
}
```

## Handoff Expectations

- `retro_summary` explains the delivery arc well enough that a future reader understands what was attempted and what mattered.
- `retro_findings` rank meaningful lessons with evidence citations, not just event lists.
- `followup_recommendation` identifies the single best next improvement, with a clear destination if the work belongs in `self-improve`.

## Stop Conditions

- The delivery cycle is still in flight.
- There is not enough concrete evidence to justify a retrospective.
- The real need is live debugging or shipping, not reflection.
- All findings are local and no follow-up action is warranted.
