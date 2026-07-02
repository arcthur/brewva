# Reference: Skills As Files

Skill files are repository knowledge and model-readable instructions. They are
not a hosted runtime authority gate.

Hosted turns render two advisory layers before the model call: a session-stable
SkillCard CATALOG (every prompt-visible skill as one bounded name +
when-to-use line, byte-identical across turns so the prompt cache holds) and a
deterministic, turn-scoped SHORTLIST of the skills that matched this turn. Both
are advisory context only; the model still chooses which SkillCard to read and
follow, and can use `discover_skills` for ranked catalog search when neither
layer fits. This does not expose tools, accounts, budgets, side effects, or
completion gates. Visibility is decoupled from selection on purpose: a scorer
miss must never mean the model cannot know a skill exists.

## Current Contract

- skills live as markdown files under `skills/**`
- skill metadata may help humans and repository tooling organize those files
- hosted turns render the catalog layer and shortlisted prompt-visible
  SkillCards before tool-surface resolution and context composition
- the catalog renders under `Brewva SkillCard Catalog` (cap 40 entries, then a
  `discover_skills` overflow pointer); shortlisted skills render under
  `Shortlisted Brewva SkillCards (this turn)`
- explicit `$skill-name` mentions, candidate counts, render counts, omission
  counts, selection reasons, and render metadata are recorded in
  `skill.selection.recorded`
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
  `selection.path_globs` against paths named in the prompt, `selection.path_globs`
  against recently touched tool paths (`recent_path`, from committed
  `tool.invocation.started` receipts — the work's location counts even when the
  prompt names no path), `name`, and shared-search-tokenized `description` /
  `selection.when_to_use` text match
- text matching is two-tiered: common intent words (the stop-word list —
  plan, review, test, code, ...) can corroborate a match but never establish
  one; at least one discriminative token overlap is always required, and a
  single discriminative token establishes the match on its own only when it
  is long (>= 8 chars) or appears in the SkillCard's name
- Chinese task wording gets a small runtime keyword bridge before text matching
  so prompts like "核心架构图" can match English SkillCard descriptions without
  adding trigger metadata to `SKILL.md`; bridge keywords stay discriminative
  even when they collide with stop words, and bridges fire only on non-ASCII
  matches
- shortlisted entries render with `name`, `category`, `filePath`,
  `selectionReasons`, `description`, and any available `whenToUse` or
  `pathGlobs`
- default render cap is 8 SkillCards
- explicit mentions over the cap are all retained and recorded with an
  over-budget reason
- no shortlisted SkillCard means Brewva records receipt-only discovery guidance;
  the catalog layer still renders, so the full skill inventory stays legible on
  every turn
- the model reads the returned `filePath` before relying on the full skill body
- SkillCard binding is current-turn only and must be selected again on later
  turns
- `discover_skills` provides optional TF-IDF catalog search through
  `@brewva/brewva-search`; returned SkillCards are recorded as
  `discover_only` / `inspect_only` invocation records on the same
  `skill.selection.recorded` event family

The event payload records `selectionId`, `trigger`, `explicitSkillMentions`,
`availableSkillCount`, `candidateSkillCount`, `renderedSkillCount`,
`omittedSkillCount`, `selectionMode`, `renderedSkillReasons`,
`skillInvocationRecords`, `promptPaths`, `recentToolPaths`, and
`renderedSkillContext`.
`selectionMode` is one of
`shortlist_prompt_context`, `explicit_over_budget_prompt_context`, or
`discover_guidance_receipt_only` for prompt shortlisting, and
`discover_only_projection` for `discover_skills` tool results.
`renderedSkillContext` contains the rendered character count and token estimate
for the SkillCard prompt block or discover projection so traces can explain
the context-budget impact without making the catalog an admission source.

Each prompt-visible or discover-returned SkillCard also produces a
`SkillInvocationRecord`. That record is advisory provenance only: skill name,
source path/package, selection trigger, invocation mode, surfaced resource refs,
token estimate, capability refs, requested output artifacts, and argument
hints. Capability refs stay empty unless a separate capability receipt exists;
a SkillCard never grants authority by being selected.

The context-excluded custom message carries explicit mention names, selection
id, selection mode, rendered reasons, counts, render metadata, and the previous
selection's ADOPTION line (how many rendered SkillCards actually had their
SKILL.md read afterwards, projected from committed `tool.invocation.started`
receipts). Offered-versus-read is the measurable definition of hit quality;
selection changes are judged against it. Window semantics: the latest VISIBLE
selection is found among the last 8 selection receipts, and reads are counted
from the invocations SINCE that receipt (bounded scan), so a long turn cannot
push an early skill read out of the measurement; blocked invocations
(`allowed: false`) and never-executed reads count for nothing. Recent-path
targets are relativized against the invocation's own `cwd` so workspace-scoped
`path_globs` match absolute tool targets. The message is visible only when a
shortlist is rendered or an explicit mention is present; no-candidate receipts
stay hidden.
`tool_surface_resolved` mirrors these as
`explicitSkillMentionNames`, `skillSelectionId`, and `skillSelectionMode`.
These fields are trace evidence, not gates.

## Derivation Direction Invariant

Skill metadata and bodies are descriptive. The runtime never derives an
unbypassable decision from them (see `design-axioms.md`, axiom 18). The boundary
has two axes — direction and binding strength — which yield three tiers:

| Tier | Flow                              | Example                                                                        | Verdict                             |
| ---- | --------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------- |
| 1    | descriptive to doc view           | a generated skill navigation view                                              | allowed                             |
| 2    | descriptive to advisory runtime   | `selection.*` feeding selection-field ranking                                  | allowed — sole registered exception |
| 3    | descriptive to authoritative gate | a readiness gate, skill activation, or artifact resolver derived from metadata | forbidden                           |

This maps onto the state-visibility rule in `design-axioms.md`: a Tier-1 view is
visibility-changing and stays projection-visible; Tier-2 ranking is advisory, so
attention stays with the model; a Tier-3 gate would be behavior-changing yet not
replay-derived, which the axiom forbids.

The sole registered Tier-2 exception is selection-field ranking: the
deterministic selector reads `selection.path_globs`, `selection.when_to_use`,
`name`, and `description` to order an advisory SkillCard shortlist (see Advisory
Shortlist above). It produces a ranking the model can ignore, not a gate. Any
new descriptive-to-runtime read site must be registered here explicitly, or it
is a Tier-3 violation.

Cross-skill handoff references in skill bodies — a verb from the closed set
`escalate to`, `hand off to`, `route to` (the one-word `handoff to` spelling is
also accepted) before a backticked skill name — are the Tier-1 source-of-record:
a build-time generator may derive an aggregate navigation view from them, but
neither the view nor the handoff lines feed runtime selection.

## Replacement Pattern

Use ordinary advisory and authority surfaces:

- advisory skill catalog context for first-turn prompt context
- file/search tools to inspect more skill markdown when needed
- capability manifests for SaaS, CLI, and MCP authority
- durable `tool.capability.selected` events for selection evidence
- durable `skill.selection.recorded` events for advisory context evidence
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
