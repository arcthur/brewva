# Concrete Example

Input: "Record the stuck recovery-posture fix so the next planner can find the root cause, failed attempts, and prevention guidance."

Output:

```json
{
  "solution_record": {
    "problem_class": "Hosted recovery posture remained active after successful provider fallback",
    "boundary": "packages/brewva-gateway/src/session/compaction-recovery.ts",
    "root_cause": "A provider fallback success path returned without recording `provider_fallback_retry` as `completed`, leaving the hosted transition snapshot in `pendingFamily=recovery`.",
    "fix": "Record the closing transition on every recovered fallback path and add regression coverage for recovery snapshot clearing plus the reduction gate that reads recovery posture.",
    "failed_attempts": [
      {
        "attempt": "Treat the issue as a `workflow_status` derivation bug",
        "outcome": "Left the underlying recovery snapshot inconsistent and the next turn still looked active",
        "lesson": "The durable transition sequence, not the advisory read model, owns recovery posture"
      }
    ],
    "preventive_guidance": [
      "Every hosted transition reason that emits `status=entered` must emit a closing `completed`, `failed`, or `skipped` event before normal turn flow resumes",
      "Recovery regression tests must assert that `pendingFamily` clears after a successful fallback retry"
    ],
    "source_artifacts": [
      "investigation_record:provider-fallback-stuck-recovery",
      "verification_evidence:turn-transition-posture-regression"
    ],
    "derivative_links": ["docs/reference/events/README.md", "docs/reference/session-lifecycle.md"]
  },
  "solution_doc_path": "docs/solutions/provider-fallback-stuck-recovery-posture.md",
  "capture_status": "created"
}
```
