# Concrete Example

Input: "Review the routing refactor for regressions."

```json
{
  "review_findings": [
    {
      "condition": "Internal routing types exported from public entrypoint",
      "impact": "Widens public API surface, creating semver commitment",
      "evidence": "Diff adds export in contracts/index.ts",
      "next_action": "Move to @brewva/brewva-runtime/internal"
    }
  ],
  "review_report": {
    "summary": "Boundary lane flagged public export widening. Compatibility lane flagged semver risk.",
    "activated_lanes": [
      "review-correctness",
      "review-boundaries",
      "review-operability",
      "review-compatibility"
    ],
    "activation_basis": "category:public_api->review-compatibility; category:package_boundary->review-compatibility",
    "missing_evidence": [],
    "precedent_consult_status": "no_relevant_precedent_found"
  },
  "merge_decision": "needs_changes"
}
```
