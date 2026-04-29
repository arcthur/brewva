# Concrete Example

Input: "Before we change hosted recovery posture, find repository precedent about `session_turn_transition`, fallback recovery, and `workflow_status`."

Output:

```json
{
  "knowledge_brief": "No direct `docs/solutions/**` precedent covers this exact provider-fallback posture case. Adjacent stable references do establish three guardrails: `session_turn_transition` is the rebuildable hosted-flow contract, recovery posture is derived from transition state rather than process-local memory, and `workflow_status` is advisory only.",
  "precedent_refs": [
    {
      "path": "docs/reference/events.md",
      "source_type": "reference",
      "key_lesson": "`session_turn_transition` is the durable contract for hosted recovery and interrupt posture"
    },
    {
      "path": "docs/reference/session-lifecycle.md",
      "source_type": "reference",
      "key_lesson": "Recovery state is rebuilt from durable runtime surfaces, not from process-local session memory"
    },
    {
      "path": "test/unit/gateway/turn-transition.unit.test.ts",
      "source_type": "test_anchor",
      "key_lesson": "Transition sequences and snapshot clearing already have unit-level contract coverage"
    }
  ],
  "preventive_checks": [
    {
      "check": "If a recovery path emits `status=entered`, tests must prove a later closing transition for the same reason and attempt",
      "source": "docs/reference/events.md + test/unit/gateway/turn-transition.unit.test.ts"
    },
    {
      "check": "Do not fix recovery posture only in `workflow_status`; the hosted transition snapshot must also clear",
      "source": "docs/reference/session-lifecycle.md"
    },
    {
      "check": "If a reduction or gating plugin reads recovery posture, add a regression that observes the gate after successful recovery",
      "source": "inferred from runtime plugin posture rules"
    }
  ],
  "precedent_query_summary": "Searched `docs/solutions/**` for `provider_fallback_retry`, `session_turn_transition`, `recovery posture`, and `workflow_status`; no direct solution record matched. Then checked `docs/reference/events.md`, `docs/reference/session-lifecycle.md`, and `test/unit/gateway/turn-transition.unit.test.ts` for stable contract anchors.",
  "precedent_consult_status": "no_relevant_precedent_found"
}
```
