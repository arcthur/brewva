# Concrete Example

Input: "Explain why the session still looked like it was recovering after provider fallback already succeeded."

Output:

```json
{
  "runtime_trace": "Turn 8 records `provider_fallback_retry` with `status=entered` and `attempt=1`. The fallback-model request then succeeds and output resumes, but no later `completed` or `failed` transition is present for that attempt. On the next turn, the hosted transition snapshot still reports `pendingFamily=recovery`, so posture-aware runtime plugins keep treating the session as mid-recovery.",
  "session_summary": "Session `sess_abc123` is functionally resumed but still advertises recovery posture because the durable provider-fallback transition sequence never closed.",
  "artifact_findings": [
    {
      "type": "anomaly",
      "layer": "event_store",
      "detail": "`provider_fallback_retry` has an `entered` record with no later `completed` or `failed` event for attempt=1",
      "severity": "high",
      "evidence_path": ".orchestrator/events/sess_c2Vzc19hYmMxMjM.jsonl"
    },
    {
      "type": "divergence",
      "layer": "derived_projection",
      "detail": "Recovery posture stays active even though later output was rendered successfully",
      "severity": "medium",
      "evidence_path": ".orchestrator/projection"
    }
  ]
}
```
