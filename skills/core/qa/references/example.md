# Concrete Example

Input: "Exercise the staging onboarding flow, try to break the risky path, and tell me if this is safe to ship."

```json
{
  "qa_verdict": "fail",
  "qa_findings": [
    {
      "severity": "high",
      "category": "functional",
      "description": "Email validation accepts malformed addresses with double dots",
      "evidence": "browser_snapshot: input 'user@test..com' accepted, form submitted",
      "reproducible": true
    }
  ],
  "qa_checks": [
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
  "qa_missing_evidence": [],
  "qa_confidence_gaps": ["Password strength meter not exercised"],
  "qa_environment_limits": []
}
```
