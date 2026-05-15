# Concrete Example

Input: "Exercise the staging onboarding flow, try to break the risky path, and tell me if this is safe to ship."

```json
{
  "verifier_verdict": "fail",
  "verifier_findings": [
    {
      "severity": "high",
      "category": "functional",
      "description": "Email validation accepts malformed addresses with double dots",
      "evidence": "browser_snapshot: input 'user@test..com' accepted, form submitted",
      "reproducible": true
    }
  ],
  "verifier_checks": [
    {
      "flow": "onboarding happy path",
      "probe_type": "happy_path",
      "tool": "browser_fill + browser_click",
      "observed": "Form submits, welcome screen shown",
      "status": "pass"
    },
    {
      "flow": "onboarding email validation",
      "probe_type": "adversarial",
      "tool": "browser_fill",
      "observed": "Malformed email accepted without error",
      "status": "fail"
    }
  ],
  "verifier_missing_evidence": [],
  "verifier_confidence_gaps": ["Password strength meter not exercised"],
  "verifier_environment_limits": []
}
```
