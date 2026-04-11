---
name: design
description: Use when a request has multiple viable approaches, crosses boundaries, or
  needs explicit trade-offs before implementation.
stability: stable
selection:
  when_to_use: Use when a request needs a bounded design, explicit trade-offs, or an executable plan before code changes.
  examples:
    - Design the approach before implementing it.
    - Compare the viable options for this change.
    - Write an execution plan for this cross-package work.
  phases:
    - align
    - investigate
intent:
  outputs:
    - design_spec
    - execution_plan
    - execution_mode_hint
    - risk_register
    - implementation_targets
  semantic_bindings:
    design_spec: planning.design_spec.v1
    execution_plan: planning.execution_plan.v1
    execution_mode_hint: planning.execution_mode_hint.v1
    risk_register: planning.risk_register.v1
    implementation_targets: planning.implementation_targets.v1
effects:
  allowed_effects:
    - workspace_read
    - runtime_observe
  denied_effects:
    - workspace_write
    - local_exec
resources:
  default_lease:
    max_tool_calls: 90
    max_tokens: 180000
  hard_ceiling:
    max_tool_calls: 130
    max_tokens: 240000
execution_hints:
  preferred_tools:
    - read
    - grep
  fallback_tools:
    - glob
    - lsp_symbols
    - lsp_find_references
    - ledger_query
    - skill_complete
references:
  - skills/meta/skill-authoring/references/authored-behavior.md
  - references/executable-evidence-bridge.md
  - references/advisor-consultation-protocol.md
  - references/plan-output-template.md
scripts:
  - scripts/classify_planning_posture.py
consumes:
  - problem_frame
  - user_pains
  - scope_recommendation
  - design_seed
  - open_questions
  - planning_posture
  - strategy_review
  - scope_decision
  - strategic_risks
  - repository_snapshot
  - impact_map
  - knowledge_brief
  - precedent_refs
  - preventive_checks
  - precedent_query_summary
  - precedent_consult_status
  - root_cause
  - runtime_trace
requires: []
---

# Design Skill

## The Iron Law

```
NO PLAN WITHOUT EXPLICIT TRADE-OFFS AND CHOSEN PATH
```

Every emitted plan names what was rejected and why.

**Violating the letter of this rule is violating the spirit of this rule.**

## When to Use

- The task has multiple viable approaches
- A change crosses package or module boundaries
- Implementation mode is not obvious
- Upstream asks for a bounded design before code changes

**Do NOT use when:**

- The change is a single-file, single-concern fix with no trade-offs
- The real work is debugging, not planning
- No design decision actually exists

## Workflow

### Phase 1: Classify planning posture

Run `scripts/classify_planning_posture.py` with scope data. Use the returned
posture to calibrate depth: `trivial` gets a lightweight plan, `high_risk`
gets full trade-off analysis and risk register.

If upstream `planning_posture` exists, reconcile it with script output. If they
disagree, use the stricter posture and note the gap.

**If scope data is unavailable**: Default to `moderate`. Do not assume triviality.

### Phase 2: Compare approaches

Offer 1–3 materially different approaches with explicit trade-offs on boundary
ownership, blast radius, migration/rollback cost, and verification strength.
Choose one path explicitly.

**If all approaches violate hard constraints**: Stop. Report the constraint
conflict. Do not force a plan through broken constraints.

### Phase 3: Validate against precedent

Use retrieved repository precedents when they fit. If you deliberately diverge
from a consulted precedent, explain why the current case is materially different.

**If no precedent exists**: Proceed. Note the absence in the risk register.

### Phase 4: Force key decisions into the open

Make boundary ownership, migration posture, verification posture, rollback
assumptions, and preventive checks explicit. Every deferred decision must be
named as deferred and assigned to a downstream skill.

**If a key decision cannot be made**: Stop at that decision. Do not paper over
it with optimistic assumptions.

### Phase 5: Emit bounded artifacts

Produce `design_spec`, `execution_plan`, `execution_mode_hint`, `risk_register`,
`implementation_targets`. Every artifact must reference concrete paths, not
vague areas.

## Scripts

- `scripts/classify_planning_posture.py` — Input: affected_paths_count,
  boundaries_crossed, has_public_surface, has_persisted_format, has_security_surface.
  Output: posture classification and reason. Run before Phase 1 depth calibration.

## Decision Protocol

- Which boundary actually owns this change?
- Which option minimizes blast radius without weakening the outcome?
- What verification evidence would prove this path was the right one?
- What migration, rollback, or operator cost is hidden by the most attractive option?
- What was rejected, and would a downstream reader agree with the rejection?

## Red Flags — STOP

If you catch yourself thinking any of these, STOP and return to Phase 2:

- "There's really only one way to do this" — without proving alternatives are worse
- "The trade-offs are obvious" — without writing them down
- "This is trivial" — when posture classification says otherwise
- "I'll figure out the rollback story later"
- "The boundary question doesn't matter for this change"

## Common Rationalizations

| Excuse                         | Reality                                                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| "Only one viable approach"     | Then proving it takes one sentence. If you can't, there are alternatives you haven't considered.                               |
| "Trade-offs are implied"       | Implied trade-offs are invisible trade-offs. Write them.                                                                       |
| "Too small to need a plan"     | Small changes that cross a boundary have outsized blast radius. If the posture script says moderate or above, it needs a plan. |
| "Precedent doesn't apply here" | State why. Precedent is a starting point, not a prison, but silent divergence is a red flag.                                   |
| "Rollback isn't relevant"      | Every change that touches shared state or public surface has a rollback story. Name it.                                        |

## Concrete Example

Input: "Refresh skill discovery so inspect and subagent workspace tooling can rely on `.brewva/skills_index.json` overlay metadata."

```json
{
  "design_spec": {
    "objective": "Expose overlay origins and routing metadata in `.brewva/skills_index.json` without widening the root runtime surface",
    "chosen_approach": "Extend the existing skill-index contracts in `packages/brewva-runtime/src/contracts/skill.ts` and emit the fields from `packages/brewva-runtime/src/skills/registry.ts`; keep gateway consumers read-only.",
    "rejected_approaches": [
      {
        "name": "CLI-side rescan of skill directories",
        "reason": "Duplicates runtime-owned discovery rules and drifts from the registry contract"
      },
      {
        "name": "Gateway-local reconstruction of overlay metadata",
        "reason": "Creates a second source of truth and widens cross-package coupling"
      }
    ],
    "boundaries": [
      "packages/brewva-runtime/src/contracts/skill.ts",
      "packages/brewva-runtime/src/skills/registry.ts",
      "packages/brewva-gateway/src/subagents/workspace.ts"
    ],
    "non_negotiable_constraints": [
      "Keep `.brewva/skills_index.json` as an inspect artifact, not durable truth",
      "No new root exports from `@brewva/brewva-runtime`",
      "Do not make gateway or CLI rescan skill directories"
    ]
  },
  "execution_plan": [
    {
      "step": 1,
      "action": "Extend skill-index types for overlay provenance and routable metadata",
      "verification": "`bun run check` stays clean"
    },
    {
      "step": 2,
      "action": "Thread the new fields through `SkillRegistry.buildIndex()` and the write path",
      "verification": "`test/contract/runtime/skills-discovery.contract.test.ts` covers the serialized artifact"
    },
    {
      "step": 3,
      "action": "Verify subagent workspace tooling still ignores `.brewva/skills_index.json` as generated state",
      "verification": "`test/unit/gateway/subagent-workspace.unit.test.ts` still passes"
    }
  ],
  "execution_mode_hint": "coordinated_rollout",
  "risk_register": [
    {
      "risk": "Consumers may start treating the generated index as durable state instead of an inspect artifact",
      "mitigation": "Keep contract docs and tests explicit that registry rebuild remains authoritative",
      "owner_lane": "review-boundaries"
    },
    {
      "risk": "Generated skill-index diffs leak into worker patch sets",
      "mitigation": "Retain `.brewva/skills_index.json` ignore handling and cover it in workspace patch tests",
      "owner_lane": "review-operability"
    }
  ],
  "implementation_targets": [
    "packages/brewva-runtime/src/contracts/skill.ts",
    "packages/brewva-runtime/src/skills/registry.ts",
    "packages/brewva-gateway/src/subagents/workspace.ts",
    "test/contract/runtime/skills-discovery.contract.test.ts",
    "test/unit/gateway/subagent-workspace.unit.test.ts"
  ]
}
```

## Handoff Expectations

- `design_spec`: what is changing, what is not, which modules own it, which
  constraints are non-negotiable, which precedents were reused or rejected.
- `execution_plan`: ordered, concrete, verification-aware. Implementation
  executes without redesigning.
- `execution_mode_hint`: evidence-based. `direct_patch` for local work,
  `test_first` when behavior needs pinning, `coordinated_rollout` for
  multi-boundary changes.
- `risk_register`: change categories, required evidence, owner lane per risk.
- `implementation_targets`: path-scoped files or directories, not vague areas.

## Stop Conditions

- A critical requirement is missing and changes the primary architecture choice
- All viable options violate hard constraints
- The real blocker is lack of repository understanding, not lack of design
