# Concrete Example

Input: "Before we change hosted recovery posture, find repository precedent about canonical runtime causes, fallback recovery, and `workflow_status`."

Output:

```json
{
  "knowledge_brief": "No direct `docs/solutions/**` precedent covers this exact provider-fallback posture case. Adjacent stable references do establish three guardrails: canonical runtime causes are the recovery contract, recovery posture is derived from tape projection rather than process-local memory, and `workflow_status` is advisory only.",
  "precedent_refs": [
    {
      "path": "docs/reference/events.md",
      "source_type": "reference",
      "key_lesson": "Canonical runtime causes are the durable contract for recovery and interrupt posture"
    },
    {
      "path": "docs/reference/session-lifecycle.md",
      "source_type": "reference",
      "key_lesson": "Recovery state is rebuilt from durable runtime surfaces, not from process-local session memory"
    },
    {
      "path": "test/fitness/gateway/recovery-decision-union.fitness.test.ts",
      "source_type": "test_anchor",
      "key_lesson": "Gateway recovery cannot reintroduce the old hosted decision lattice"
    }
  ],
  "preventive_checks": [
    {
      "check": "If a recovery path emits a canonical cause, tests must prove its tape projection and hosted frame mapping",
      "source": "docs/reference/runtime.md + test/fitness/gateway/recovery-decision-union.fitness.test.ts"
    },
    {
      "check": "Do not fix recovery posture only in `workflow_status`; canonical tape projection must also explain it",
      "source": "docs/reference/session-lifecycle.md"
    },
    {
      "check": "If a reduction or gating plugin reads recovery posture, add a regression that observes the gate after successful recovery",
      "source": "inferred from runtime plugin posture rules"
    }
  ],
  "precedent_query_summary": "Searched `docs/solutions/**` for `provider_retry`, canonical runtime causes, `recovery posture`, and `workflow_status`; no direct solution record matched. Then checked `docs/reference/runtime.md`, `docs/reference/session-lifecycle.md`, and `test/fitness/gateway/recovery-decision-union.fitness.test.ts` for stable contract anchors.",
  "precedent_consult_status": "no_relevant_precedent_found"
}
```
