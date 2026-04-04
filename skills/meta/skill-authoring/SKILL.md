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

# Skill Authoring Skill

## Intent

Create or revise skills so they have clear semantic territory, stable artifacts,
behavior-rich instructions, and the right routing posture.

## Trigger

Use this skill when:

- adding a new skill to the catalog
- redesigning an existing skill boundary
- tightening a skill contract or artifact schema

## Workflow

### Step 1: Define territory

State the semantic boundary, trigger, and what should stay out of scope.

### Step 2: Shape the contract

Produce:

- `skill_spec`: purpose, trigger, and boundaries
- `skill_contract`: intent, effect governance, explicit `default_lease` plus
  `hard_ceiling`, and execution hints
- `skill_scaffold`: a minimal SKILL skeleton and required resources
- when an output is an array of structured objects, prefer `kind: json` plus a
  recursive `item_contract` instead of leaving the array shape implicit

### Step 3: Author the behavior, not just the schema

Ensure the skill body makes the specialist usable in practice:

- define the role posture and what it optimizes for
- add an interaction protocol for when to ask, proceed, or re-ground
- add a decision protocol so the model knows how to choose, rank, or classify
- turn abstract judgment into concrete questions when the skill depends on
  analysis rather than rote execution
- add confirmation gates when the workflow crosses a write, publish, approval,
  or release boundary
- add handoff expectations so downstream skills receive useful artifacts
- add a short pre-delivery checklist when output quality depends on several
  concrete final checks
- make stop conditions and escalation behavior explicit
- when authoring a project overlay, inherit base-skill questions, gates, and
  checklists; add only the project-specific delta (see
  `references/authored-behavior.md` § Overlay Inheritance)

### Step 4: Use the current scaffolding tools when structure matters

Use:

- `scripts/init_skill.py` to scaffold a skill under the right category
- `scripts/fork_skill.py` to fork an existing skill into `project/overlays/<name>`
- `scripts/quick_validate.py` before packaging
- `scripts/package_skill.py` when a distributable bundle is needed

## Interaction Protocol

- Re-ground on the target skill territory, current contract shape, and why the
  existing skill is insufficient before redesigning anything.
- Ask only when the semantic boundary, routing posture, or intended outputs are
  too unclear to produce a stable skill contract.
- Prefer tightening an existing skill or overlay when it preserves catalog
  clarity better than creating a new public skill.

## Handoff Expectations

- `skill_spec` should make the semantic territory and non-goals obvious to the
  next maintainer.
- `skill_contract` should capture the runtime-facing boundary cleanly enough
  that implementation does not need to infer missing authority rules.
- `skill_scaffold` should give a maintainer enough structure to finish the skill
  body without reinventing workflow, resources, or artifact semantics.

## Stop Conditions

- the new skill is really a runtime phase or policy, not a capability
- the skill duplicates existing semantic territory
- there is no stable artifact contract to justify a new skill

## Anti-Patterns

- encoding lifecycle steps as public skills
- creating a new skill when a mode or overlay would suffice
- writing prompts with no durable artifact semantics
- shipping contract-only skeletons that tell runtime what outputs exist but do
  not tell the model how the specialist should behave

## Example

Input: "Design an overlay-aware runtime-forensics skill contract for Brewva."

Output: `skill_spec`, `skill_contract`, `skill_scaffold`.
