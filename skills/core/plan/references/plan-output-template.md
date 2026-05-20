# Plan Output Example

Use this shape when emitting the structured planning artifacts described by
`skills/producers/plan.yaml`. The SkillCard remains advisory; this example is a
producer output shape, not `SKILL.md` frontmatter.

```json
{
  "design_spec": "Align canonical semantic bindings, control-plane tool classification, repair posture, and unclean shutdown diagnostics without widening generic skill authoring.",
  "execution_plan": [
    {
      "step": "Introduce semantic bindings for runtime-consumed planning artifacts.",
      "intent": "Make planning outputs derive from canonical schema ids instead of drifting copies.",
      "owner": "runtime",
      "exit_criteria": "Producer contracts declare semantic_bindings and runtime validates against canonical contracts.",
      "verification_intent": "Contract tests prove producer contracts and examples stay aligned."
    },
    {
      "step": "Move task and workflow lifecycle tools onto the control plane.",
      "intent": "Stop misclassifying explicit collaboration state as specialist memory_write effects.",
      "owner": "gateway",
      "exit_criteria": "Task and workflow tools bypass skill effect authorization while remaining fully budgeted and observable.",
      "verification_intent": "Authorization tests show task ledger updates no longer emit unauthorized-effects warnings."
    },
    {
      "step": "Enforce repair posture after invalid producer output.",
      "intent": "Prevent free-form retries from re-expanding context after a producer contract failure.",
      "owner": "runtime",
      "exit_criteria": "Invalid output enters repair_required with bounded attempts, tool calls, and token budget.",
      "verification_intent": "Producer contract tests show invalid outputs surface repair state and restricted tool availability."
    }
  ],
  "execution_mode_hint": "coordinated_rollout",
  "risk_register": [
    {
      "risk": "Control-plane reclassification could accidentally widen tool visibility during capability-selected turns.",
      "category": "permission_policy",
      "severity": "high",
      "mitigation": "Restrict repair posture to an explicit control-plane allowlist and keep tool-surface tests exhaustive.",
      "required_evidence": [
        "runtime-plugin tool-surface contract coverage",
        "authorization regression test"
      ],
      "owner_lane": "review-security"
    },
    {
      "risk": "Hydration reconciliation could flag live sessions as unclean if it runs too aggressively.",
      "category": "wal_replay",
      "severity": "medium",
      "mitigation": "Only reconcile when open tool calls or open turns remain after a grace period and no terminal receipt exists.",
      "required_evidence": ["session recovery system test", "event tape inspection assertion"],
      "owner_lane": "review-operability"
    }
  ],
  "implementation_targets": [
    {
      "target": "packages/brewva-runtime/src/internal/legacy-runtime/model/skills/producers.ts",
      "kind": "runtime-service",
      "owner_boundary": "runtime producer contracts",
      "reason": "Own producer validation and canonical output enforcement."
    },
    {
      "target": "packages/brewva-gateway/src/hosted/internal/session/tools/tool-surface.ts",
      "kind": "runtime-plugin",
      "owner_boundary": "gateway tool visibility",
      "reason": "Apply capability selection and expose control-plane tools intentionally."
    }
  ]
}
```

Rules:

- `execution_plan[*]` must always include `step`, `intent`, `owner`,
  `exit_criteria`, and `verification_intent`.
- `risk_register[*]` must always include `risk`, `category`, `severity`,
  `mitigation`, `required_evidence`, and `owner_lane`.
- `implementation_targets[*]` must stay concrete enough to map directly onto
  later `files_changed`.
