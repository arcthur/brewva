# Concrete Example

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
