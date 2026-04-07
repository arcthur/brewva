---
name: skill-authoring
description: Design or revise a skill contract, instructions, and artifacts so the
  catalog stays coherent and composable.
stability: stable
selection:
  when_to_use: Use when adding or revising a skill contract, instructions, or artifact schema so the skill is easier to load, execute, and complete correctly.
  examples:
    - Design a new skill for this workflow.
    - Refactor this skill contract and instructions.
    - Tighten the artifact schema for this skill.
  paths:
    - skills
  phases:
    - align
    - investigate
    - execute
intent:
  outputs:
    - skill_spec
    - skill_contract
    - skill_scaffold
  output_contracts:
    skill_spec:
      kind: text
      min_words: 3
      min_length: 18
    skill_contract:
      kind: text
      min_words: 3
      min_length: 18
    skill_scaffold:
      kind: text
      min_words: 3
      min_length: 18
effects:
  allowed_effects:
    - workspace_read
    - local_exec
    - runtime_observe
  denied_effects:
    - workspace_write
resources:
  default_lease:
    max_tool_calls: 70
    max_tokens: 140000
  hard_ceiling:
    max_tool_calls: 110
    max_tokens: 200000
execution_hints:
  preferred_tools:
    - read
    - grep
  fallback_tools:
    - exec
    - glob
    - ledger_query
    - skill_complete
references:
  - references/authored-behavior.md
  - references/output-patterns.md
  - references/workflows.md
  - references/skill-anatomy-v2.md
scripts:
  - scripts/init_skill.py
  - scripts/fork_skill.py
  - scripts/package_skill.py
  - scripts/quick_validate.py
consumes:
  - repository_snapshot
  - design_spec
requires: []
---

# Skill Authoring

## The Iron Law

```
NO SKILL WITHOUT A FAILING TEST FIRST
```

Author the behavior, not just the schema.

## When to Use / When NOT to Use

Use when:

- adding a new skill to the catalog
- redesigning an existing skill boundary or contract
- tightening artifact schemas or output contracts
- migrating a skill body to the v2 anatomy (`references/skill-anatomy-v2.md`)

Do NOT use when:

- the change is a runtime phase or policy — that belongs in runtime config
- a mode or project overlay would suffice — do not create a new public skill
- the work is pure implementation with no skill contract impact

## Workflow

### Phase 1: Write a failing test

Before writing any skill body, define what "correct" looks like:

- what artifacts must the skill produce?
- what frontmatter fields are required?
- what body sections must exist?

Run `scripts/quick_validate.py` against the target path. It must fail for the
right reasons before you write the skill.

**If you cannot articulate a failing test**: Stop. The skill boundary is not
clear enough to author. Return to design.

### Phase 2: Define territory

State the semantic boundary, trigger conditions, and what stays out of scope.
Classify every piece of content using the three-type rule from
`references/skill-anatomy-v2.md`: deterministic → scripts, judgment → SKILL.md
body, knowledge → references.

**If the territory overlaps an existing skill**: Stop. Prefer tightening the
existing skill or creating an overlay.

### Phase 3: Shape the contract

Produce:

- `skill_spec`: purpose, trigger, boundaries, and non-goals
- `skill_contract`: intent, effect governance, `default_lease` + `hard_ceiling`,
  execution hints, and output contracts
- `skill_scaffold`: minimal SKILL.md skeleton following v2 anatomy

Apply the v2 section order: Iron Law → When to Use → Workflow (with failure
branches) → Scripts → Decision Protocol → Red Flags → Common Rationalizations →
Concrete Example → Handoff Expectations → Stop Conditions.

**If the body exceeds 150 lines**: Extract tables, schemas, or protocol details
to `references/`. Extract deterministic logic to `scripts/`.

### Phase 4: Validate and package

Run `scripts/quick_validate.py` — it must now pass.
Use `scripts/init_skill.py` for new skills, `scripts/fork_skill.py` for overlays,
and `scripts/package_skill.py` when a distributable bundle is needed.

**If validation fails**: Fix the skill body, do not skip validation.

## Scripts

- `scripts/init_skill.py` — Scaffold a skill under the right category directory.
- `scripts/fork_skill.py` — Fork an existing skill into `project/overlays/<name>`.
- `scripts/quick_validate.py` — Validate frontmatter, section presence, and body
  line count. Run before and after authoring.
- `scripts/package_skill.py` — Produce a distributable skill bundle.

## Decision Protocol

- Does this need a new skill, or can an existing skill absorb it?
- Is every piece of deterministic content in a script, not prose?
- Does the Iron Law capture the single most important constraint?
- Do workflow phases have explicit failure branches?
- Would a model that reads only the Iron Law and the Workflow still behave safely?
- Are description fields trigger-only, not workflow summaries?

## Red Flags — STOP

If you catch yourself thinking any of these, STOP and return to Phase 1:

- "Ship the contract skeleton now, add behavior later"
- "The description can summarize the workflow for convenience"
- "This deterministic logic is simple enough to leave in prose"
- "Skip the test, I know the structure is right"

## Common Rationalizations

| Excuse                                         | Reality                                                                   |
| ---------------------------------------------- | ------------------------------------------------------------------------- |
| "Contract-only skeleton is a good first step"  | Skeletons without behavior cause models to hallucinate workflow.          |
| "Prose instructions are clearer than a script" | Models follow scripts deterministically; they interpret prose creatively. |
| "One skill per task keeps things simple"       | Overlapping skills cause routing confusion. Territory must be exclusive.  |
| "150 lines is too restrictive"                 | If the body is longer, content belongs in references/ or scripts/.        |
| "Description can hint at the workflow"         | Models follow descriptions instead of reading the body. Trigger-only.     |

## Concrete Example

Input: "Design a new runtime-forensics skill for Brewva."

Output:

```json
{
  "skill_spec": {
    "name": "runtime-forensics",
    "territory": "Runtime artifact inspection and causal trace reconstruction",
    "trigger": "Task asks what happened at runtime from artifact evidence",
    "non_goals": ["source-level debugging", "fix implementation", "hypothetical analysis"]
  },
  "skill_contract": {
    "outputs": ["runtime_trace", "session_summary", "artifact_findings"],
    "effects": {
      "allowed": ["workspace_read", "local_exec", "runtime_observe"],
      "denied": ["workspace_write"]
    },
    "default_lease": { "max_tool_calls": 80, "max_tokens": 160000 }
  },
  "skill_scaffold": "SKILL.md with v2 anatomy: Iron Law, 4-phase workflow with failure branches, 1 script, decision protocol, red flags, rationalizations table, concrete example with real JSON"
}
```

## Handoff Expectations

- `skill_spec` makes semantic territory and non-goals obvious to the next
  maintainer without reading the full body.
- `skill_contract` captures the runtime-facing boundary so implementation does
  not need to infer missing authority rules.
- `skill_scaffold` gives a maintainer enough structure to finish the skill body
  following v2 anatomy without reinventing sections.

## Stop Conditions

- The proposed skill is really a runtime phase or policy, not a capability.
- The skill duplicates existing semantic territory without justification.
- There is no stable artifact contract to justify a new skill.
- The failing test cannot be articulated — boundary is too vague.

Violating the letter is violating the spirit.
