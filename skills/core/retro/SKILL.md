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

Input: "We shipped the `brewva insights` refresh; summarize what slowed us down and what to fix next time."

Output:

```json
{
  "retro_summary": "The `brewva insights` refresh shipped after a 1-day delay. Runtime and CLI code landed quickly, but inspect-payload wording and docs drift created two extra review loops. The main lesson is that command-surface and reference-doc changes need to travel in the same batch when an inspect artifact or CLI view changes.",
  "retro_findings": [
    {
      "finding": "Inspect payload change reached review before docs and command help were updated",
      "type": "systemic",
      "evidence": "review_report flagged stale docs and help-surface wording after the CLI renderer already matched the new payload",
      "impact": "Two extra review passes to realign command, docs, and examples"
    },
    {
      "finding": "Generated inspect artifacts needed explicit patch-ignore verification",
      "type": "local",
      "evidence": "qa_report noted `.brewva/skills_index.json` appearing in workspace patch previews until the generated-artifact expectation was rechecked",
      "impact": "Short rework cycle; added targeted workspace regression coverage"
    },
    {
      "finding": "Scope discipline held: the refresh stayed read-only and did not widen into daemon mutations",
      "type": "positive",
      "evidence": "ship_report matched the original scope_decision and no release-time patch work was introduced",
      "impact": "Avoided a larger operator-surface rewrite"
    }
  ],
  "followup_recommendation": "Add a pre-review checklist item for CLI and inspect-surface work: when an output payload, command surface, or generated inspect artifact changes, update the paired docs/tests in the same batch before review begins."
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
