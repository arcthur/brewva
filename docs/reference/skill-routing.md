# Reference: Skills As Files

Skill files are repository knowledge and model-readable instructions. They are
not a hosted runtime authority gate.

Hosted turns render the available SkillCard catalog before the model call. The
model chooses which SkillCard to follow from the rendered descriptions and can
use `discover_skills` for ranked catalog search. This does not expose tools,
accounts, budgets, side effects, or completion gates.

## Current Contract

- skills live as markdown files under `skills/**`
- skill metadata may help humans and repository tooling organize those files
- hosted turns render prompt-visible SkillCards before tool-surface resolution
  and context composition
- available skills are prompt context under `Available Brewva Skills`
- explicit `$skill-name` mentions and render metadata are recorded in
  `skill_selection_recorded`
- explicit mentions are mirrored into a hidden, context-excluded
  `brewva-skill-selection` turn message without replaying the trace marker as
  model context
- hosted turns do not require an activation tool before repository work
- completion is expressed through normal task, verification, and workbench
  surfaces

Skills are advisory context. External action authority goes through capability
selection, durable selection receipts, and runtime governance.

## Deleted Runtime Concept

The former hosted skill gate has been removed:

- no explicit activation envelope
- no completion reminder lifecycle
- no runtime tool-surface narrowing based on active skill state
- no channel policy that requires loading a channel skill

This deletion is intentional. It keeps the default execution path
model-operated: available SkillCards guide attention, while the model decides
which documents to read and which tools to call, and the runtime governs
consequences.

## Advisory Catalog

Skill routing is model-native and bounded by prompt context:

- every prompt-visible SkillCard is rendered with `name`, `description`,
  `selection.when_to_use`, and `filePath`
- if the user mentions `$skill-name` or the task matches the rendered
  description, the model follows that SkillCard for the turn
- the model reads the returned `filePath` before relying on the full skill body
- descriptions are truncated when the catalog would exceed the token budget,
  but all names remain visible
- `discover_skills` provides optional TF-IDF catalog search through
  `@brewva/brewva-search`

The event payload records `selectionId`, `trigger`, `explicitSkillMentions`,
`availableSkillCount`, `renderedSkillContext`, and
`mode: "available_catalog_prompt_context"`. `renderedSkillContext` contains the
rendered character count and token estimate for the SkillCard catalog prompt
block so traces can explain the context-budget impact.

The hidden custom message carries explicit mention names, selection id, mode,
and render metadata. `tool_surface_resolved` mirrors these as
`explicitSkillMentionNames`, `skillSelectionId`, and `skillSelectionMode`.
These fields are trace evidence, not gates.

## Replacement Pattern

Use ordinary advisory and authority surfaces:

- advisory skill catalog context for first-turn prompt context
- file/search tools to inspect more skill markdown when needed
- capability manifests for SaaS, CLI, and MCP authority
- durable `capability_selection_recorded` events for selection evidence
- durable `skill_selection_recorded` events for advisory context evidence
- `workbench_note` for model-authored durable working notes
- `workbench_evict` to evict stale context with optional replacement notes
- `task_set_spec` and `task_view_state` for task state
- `workflow_status` for derived progress inspection
- verification tools for evidence and acceptance

The runtime may still expose skill inventory for inspection or migration work,
but that inventory is not an authority plane.

## Capability Selection Priority

External action authority is selected by the capability control plane, not by
skill routing. The promoted implementation currently executes only the
deterministic stages:

1. explicit target, such as `/capability:name` or `@capability:name`
2. policy default within the agent, workspace, and account allowlists
3. deterministic filters and selection-field ranking

Stages 4 and 5 from the RFC, embedding ranking and LLM fallback, are reserved
and intentionally inactive in this implementation. If stages 1-3 do not select
a capability, no SaaS, CLI, MCP, or operator authority is exposed. This is a
stricter fail-closed behavior than the RFC fallback path and prevents write
authority from appearing because a model guessed the route.

## Migration Guidance

When old docs or tests describe mandatory skill activation, rewrite the flow as:

1. the model reads whichever local instructions are useful
2. the model records important decisions in the workbench
3. the runtime records effects, verification, and receipts
4. recovery uses tape and workbench baselines rather than an active skill slot

Do not replace the removed gate with another hidden authority router. If a
workflow needs external authority, put it behind a manifest-backed capability
and deterministic policy gate. If it only needs extra context, make it a
SkillCard, readable file, or advisory tool.
