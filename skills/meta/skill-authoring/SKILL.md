---
name: skill-authoring
description: Design or revise a SkillCard, ProducerContract, instructions, and artifacts so
  the catalog stays coherent and composable.
references:
  - references/authored-behavior.md
  - references/output-patterns.md
  - references/workflows.md
  - references/skill-anatomy-v2.md
  - references/example.md
  - references/rationalizations.md
scripts:
  - scripts/init_skill.py
  - scripts/fork_skill.py
  - scripts/package_skill.py
  - scripts/quick_validate.py
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
- redesigning an existing SkillCard boundary or ProducerContract
- tightening producer artifact schemas or output contracts
- migrating a skill body to the v2 anatomy (`references/skill-anatomy-v2.md`)

Do NOT use when:

- the change is a runtime phase or policy — that belongs in runtime config
- a mode or project overlay would suffice — do not create a new public skill
- the work is pure implementation with no SkillCard or ProducerContract impact

## Workflow

### Phase 1: Write a failing test

Before writing any skill body, define what "correct" looks like:

- what artifacts must the skill produce?
- what frontmatter fields are required?
- what body sections must exist?

Run `scripts/quick_validate.py` against the target path. It must fail for the
right reasons before you write the skill.

**If you cannot articulate a failing test**: Stop. The skill boundary is not
clear enough to author. Return to plan.

### Phase 2: Define territory

State the semantic boundary, trigger conditions, and what stays out of scope.
Classify every piece of content using the three-type rule from
`references/skill-anatomy-v2.md`: executable deterministic logic → `scripts/`
when `local_exec` is allowed, read-only deterministic rules → `invariants/`,
judgment → SKILL.md body, knowledge → references.

Use the latent/deterministic split explicitly:

| Content type                                                                  | Put it in     | Reason                                                                    |
| ----------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------- |
| Executable checks, transformations, validators, and repeatable classification | `scripts/`    | Code gives the host a stable mechanism when the skill may execute locally |
| Read-only deterministic rules, gates, and classifier tables                   | `invariants/` | The rule is stable without implying the active skill can run local code   |
| Judgment, sequencing, stop rules, and failure-mode handling                   | `SKILL.md`    | The body should teach the model when and how to decide                    |
| Background knowledge, examples, taxonomies, and large tables                  | `references/` | Reference material stays available without bloating the active protocol   |

Do not encode deterministic behavior as "remember to..." prose. Use `scripts/`
when the skill is allowed to execute locally; use `invariants/` when the skill
is read-only.

**If the territory overlaps an existing skill**: Stop. Prefer tightening the
existing skill or creating an overlay.

### Phase 3: Shape the card and producer

Produce:

- `skill_spec`: purpose, trigger, boundaries, and non-goals
- `skill_card`: minimal advisory frontmatter: `name`, `description`,
  optional `selection`, and resource links only
- `producer_contract`: `producers/<name>.yaml` output names,
  `output_contracts`, and `semantic_bindings`
- `skill_scaffold`: minimal SKILL.md skeleton following v2 anatomy

Do not put authority, tool access, effects, resources, routing, budgets, or
outputs in SKILL.md. Capability manifests own external action authority.
Producer contracts own structured output shape.

Apply the v2 section order: Iron Law → When to Use → Workflow (with failure
branches) → Invariants or Scripts → Decision Protocol → Red Flags → Common
Rationalizations → Concrete Example → Handoff Expectations → Stop Conditions.

**If the body exceeds 150 lines**: Extract tables, schemas, or protocol details
to `references/`. Extract executable deterministic logic to `scripts/` only
when `local_exec` is allowed; otherwise extract the rule set to `invariants/`.

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
- Is every piece of deterministic content in a script or invariant, not prose?
- Are all external actions represented by capabilities rather than skill prose?
- Are all structured outputs represented by a ProducerContract rather than SKILL.md frontmatter?
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

See `references/rationalizations.md` for the anti-pattern table.

## Concrete Example

See `references/example.md` for the grounded example output shape.

## Handoff Expectations

- `skill_spec` makes semantic territory and non-goals obvious to the next
  maintainer without reading the full body.
- `skill_card` stays advisory and does not imply external action authority.
- `producer_contract` captures the structured output boundary so downstream
  consumers do not infer artifact shape from prose.
- `skill_scaffold` gives a maintainer enough structure to finish the skill body
  following v2 anatomy without reinventing sections.

## Stop Conditions

- The proposed skill is really a runtime phase, policy, or capability manifest.
- The skill duplicates existing semantic territory without justification.
- There is no stable artifact contract to justify a new skill.
- The failing test cannot be articulated — boundary is too vague.
