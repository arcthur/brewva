# Concrete Example

Input: "Provider fallback succeeds, but the session still behaves as if recovery is active on the next turn."

Output:

```json
{
  "root_cause": "A success branch in `packages/brewva-gateway/src/session/compaction-recovery.ts` returned from provider fallback without recording the matching `provider_fallback_retry` `completed` transition. The hosted transition snapshot therefore kept `pendingFamily=\"recovery\"`, and downstream recovery-aware posture checks continued to treat the session as mid-recovery.",
  "fix_strategy": "Record a closing transition on every recovered provider-fallback path and add regression coverage around transition snapshot clearing plus the reduction gate that reads recovery posture.",
  "failure_evidence": "Session history shows `provider_fallback_retry` with `status=entered` but no later `completed` or `failed` record for the same attempt; the next turn still reports recovery posture as active.",
  "investigation_record": {
    "hypotheses_tested": [
      {
        "id": 1,
        "claim": "Fallback model selection is wrong, so recovery never actually succeeds",
        "status": "falsified",
        "evidence": "Fallback-model output renders successfully before the next turn begins"
      },
      {
        "id": 2,
        "claim": "Recovery posture looks stale only because `workflow_status` was derived from old artifacts",
        "status": "falsified",
        "evidence": "The hosted recovery snapshot itself still reports `pendingFamily=recovery` before workflow derivation runs"
      },
      {
        "id": 3,
        "claim": "The provider-fallback path never records the closing transition after a successful retry",
        "status": "confirmed",
        "evidence": "The event log contains `provider_fallback_retry entered` with no matching close event; the reduction gate keeps reading an active recovery posture"
      }
    ],
    "failed_attempts": [],
    "root_cause_boundary": "packages/brewva-gateway/src/session/compaction-recovery.ts",
    "verification_linkage": "transition history inspection plus `test/unit/gateway/turn-transition.unit.test.ts` and `test/unit/gateway/provider-request-reduction.unit.test.ts`"
  },
  "planning_posture": "moderate"
}
```
