# Reference: Skills As Files

Skill files are repository knowledge and model-readable instructions. They are
not a hosted runtime authority gate.

Hosted turns render a deterministic, turn-scoped SkillCard shortlist before the
model call. The shortlist is advisory context only; the model still chooses
which SkillCard to read and follow, and can use `discover_skills` for ranked
catalog search when no shortlist item fits. This does not expose tools,
accounts, budgets, side effects, or completion gates.

## Current Contract

- skills live as markdown files under `skills/**`
- skill metadata may help humans and repository tooling organize those files
- hosted turns render shortlisted prompt-visible SkillCards before
  tool-surface resolution and context composition
- shortlisted skills are prompt context under `Available Brewva SkillCards`
- explicit `$skill-name` mentions, candidate counts, render counts, omission
  counts, selection reasons, and render metadata are recorded in
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

## Advisory Shortlist

Skill routing is model-native and bounded by prompt context:

- prompt-visible SkillCards are pre-filtered by explicit `$skill` mention,
  `selection.path_globs`, `name`, and shared-search-tokenized `description` /
  `selection.when_to_use` text match
- Chinese task wording gets a small runtime keyword bridge before text matching
  so prompts like "核心架构图" can match English SkillCard descriptions without
  adding trigger metadata to `SKILL.md`
- shortlisted entries render with `name`, `category`, `filePath`,
  `selectionReasons`, `description`, and any available `whenToUse` or
  `pathGlobs`
- default render cap is 8 SkillCards
- explicit mentions over the cap are all retained and recorded with an
  over-budget reason
- no shortlisted SkillCard means Brewva records receipt-only discovery guidance
  and relies on the stable operating contract instead of injecting an empty
  per-turn SkillCard block
- the model reads the returned `filePath` before relying on the full skill body
- SkillCard binding is current-turn only and must be selected again on later
  turns
- `discover_skills` provides optional TF-IDF catalog search through
  `@brewva/brewva-search`

The event payload records `selectionId`, `trigger`, `explicitSkillMentions`,
`availableSkillCount`, `candidateSkillCount`, `renderedSkillCount`,
`omittedSkillCount`, `selectionMode`, `renderedSkillReasons`, and
`promptPaths`, and `renderedSkillContext`. `selectionMode` is one of
`shortlist_prompt_context`, `explicit_over_budget_prompt_context`, or
`discover_guidance_receipt_only`. `renderedSkillContext` contains the
rendered character count and token estimate for the SkillCard prompt block so
traces can explain the context-budget impact.

The context-excluded custom message carries explicit mention names, selection
id, selection mode, rendered reasons, counts, and render metadata. It is visible
only when a shortlist is rendered or an explicit mention is present; no-candidate
receipts stay hidden.
`tool_surface_resolved` mirrors these as
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
