# Concrete Example

Input: "Extract a triage record from: 'Deploy broke prod at 3pm. Users seeing
500s on /api/checkout. Rolled back at 3:15. Not sure if config or auth
middleware. Sarah saw memory spikes. P1 or P2, needs triage.'"

```json
{
  "structured_payload": {
    "incident_id": null,
    "severity": "P1_or_P2",
    "affected_endpoint": "/api/checkout",
    "symptom": "HTTP 500 errors on checkout endpoint",
    "timeline": { "detected": "15:00", "mitigated": "15:15", "action": "rollback" },
    "suspected_causes": ["config change", "new auth middleware"],
    "supplemental_signals": [{ "source": "Sarah", "observation": "memory spikes" }],
    "root_cause": null,
    "status": "needs_triage"
  },
  "extraction_report": "Extracted 8/10 fields. severity is ambiguous (P1 or P2) — kept as explicit uncertainty. incident_id and root_cause are null (no source evidence). Source quality: noisy."
}
```
