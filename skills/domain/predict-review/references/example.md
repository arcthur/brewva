# Concrete Example

Input: "Before we run another bounded optimization pass, predict why the metric keeps stalling."

Output:

```json
{
  "perspective_findings": [
    {
      "perspective": "Reliability Engineer",
      "profile": "review-operability",
      "primary_claim": "Optimization loop silently drops iterations when WAL replay hits a stale epoch boundary, causing the metric to plateau at the pre-replay value.",
      "evidence": [
        "WAL replay logs show epoch=3 while optimizer expects epoch=5",
        "Metric flatlines exactly at replay timestamp"
      ],
      "uncertainty": "Unknown whether epoch mismatch is from replay or optimizer checkpointing."
    },
    {
      "perspective": "Devil's Advocate",
      "profile": "explore",
      "primary_claim": "The metric may have genuinely converged — the stall could be a real plateau, not a bug.",
      "evidence": ["Loss curve shape matches typical convergence for this problem class"],
      "uncertainty": "No controlled run exists to compare converged vs stalled behavior."
    }
  ],
  "debate_summary": {
    "converged": ["Stall correlates with WAL replay timing"],
    "unresolved": [
      "Genuine convergence vs epoch-boundary bug — no controlled baseline to distinguish"
    ],
    "missing_evidence": ["Controlled run without replay to establish true convergence baseline"]
  },
  "ranked_hypotheses": [
    {
      "rank": 1,
      "claim": "Stale epoch after WAL replay causes silent iteration drops",
      "confidence": "medium-high",
      "validation": "Pin epoch to post-replay value and compare trajectory",
      "falsification": "If metric still stalls after epoch fix, cause is genuine convergence"
    },
    {
      "rank": 2,
      "claim": "True convergence plateau",
      "confidence": "medium",
      "validation": "Run controlled baseline without replay on same input",
      "falsification": "If controlled run improves past stall point, convergence is ruled out"
    }
  ]
}
```
