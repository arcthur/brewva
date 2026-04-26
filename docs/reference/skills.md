# Reference: Skills

Skill parsing, merge, and runtime-facing lifecycle logic:

- `packages/brewva-runtime/src/skills/contract.ts`
- `packages/brewva-runtime/src/skills/registry.ts`
- `packages/brewva-runtime/src/services/skill-lifecycle.ts`
- `packages/brewva-gateway/src/runtime-plugins/tool-surface.ts`
- `packages/brewva-gateway/src/runtime-plugins/hosted-context-injection-pipeline.ts`

This page is the contract and configuration reference for skill metadata,
catalog shape, routing scopes, and explicit activation semantics. Turn-level
recommendation order, warm-transition heuristics, and canonical lifecycle
chains live in `docs/reference/skill-routing.md`.

## Current Model

Skill taxonomy is now split by role:

- public routable skills: routable semantic territory
- runtime/control-plane workflow semantics: not public skills
- project overlays: project-specific tightening, execution guidance, and project-guidance augmentation
- operator/meta skills: loaded, but usually not exposed through the routable index

This keeps lifecycle choreography out of the public catalog.

## Skills vs Delegation

Skills and delegated workers solve different problems and stay intentionally
separate.

- `skill`
  - semantic contract for the work
  - expected outputs, effect ceilings, completion rules, and budget ceilings
- `execution envelope`
  - runtime posture for delegated work
  - boundary, model/tool surface narrowing, and runtime budgets
- `agent spec`
  - named delegated worker configuration
  - composes a default `skillName` with an envelope and authored specialist
    instructions

Current rules:

- a child run may bind a delegated skill directly or through an `agentSpec`
- when `skillName` is present, the runner injects the skill body and output
  contract into the child prompt rather than relying on a follow-up `skill_load`
  call
- child runtime skill activation is reserved for executable child-owned roles
  such as `qa`; consult runs stay advisory and do not create a second
  authoritative skill lifecycle
- the runner validates returned `skillOutputs` against the delegated skill
  contract only for child-owned executable roles
- the parent session remains the authority that owns active skill state,
  completion, and patch adoption
- the stable built-in public specialist surface is `advisor`, `qa`, and
  `patch-worker`; internal review lanes remain internal fan-out
  helpers rather than public taxonomy
- delegated `consult` is the first-class read-only result posture with
  canonical `consultKind`-specific typed data
- patch-producing child runs return `WorkerResult` / patch artifacts for the
  parent-controlled `worker_results_merge` -> `worker_results_apply` flow
- delegated QA runs do not produce `WorkerResult`; they persist canonical
  `QaSubagentOutcomeData` in delegated outcome data, while mirrored
  `skillOutputs.qa_*` remain lifecycle-facing projections

## Contract Metadata

Skill frontmatter supports intent, effect, resource, and execution metadata:

- `name`
  - optional; defaults to the containing skill directory name when omitted
- `description`
  - optional short summary; defaults to `<name> skill`
- `intent.outputs/intent.output_contracts/intent.semantic_bindings`
- optional `selection.when_to_use/selection.examples/selection.paths/selection.phases`
- `requires` / `consumes`
- `composable_with`
- `effects.allowed_effects/effects.denied_effects`
- `resources.default_lease/resources.hard_ceiling`
- optional `execution_hints.preferred_tools/execution_hints.fallback_tools/execution_hints.cost_hint`
- resource lists: `references`, `scripts`, `heuristics`, `invariants`

Structured metadata is only strong when runtime or control-plane code consumes
it directly:

| Metadata family                                      | Contract strength                       | Consumer                                                                                    |
| ---------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------- |
| `description` and markdown body                      | descriptive                             | model and operator judgment                                                                 |
| `selection.*`                                        | routing input                           | gateway cold-start `skill-first` recommendation                                             |
| `requires` / `consumes`                              | artifact-readiness contract             | runtime skill readiness, `workflow_status`, `skill_load`, skill-routing context             |
| `composable_with`                                    | lifecycle contract                      | `SkillLifecycleService` activation gate                                                     |
| `intent.*`                                           | producer and semantic-consumer contract | completion validation, normalization, downstream consumed outputs                           |
| `effects.*` and `resources.*`                        | authority and budget contract           | tool policy, resource lease, execution boundary                                             |
| `execution_hints.preferred_tools` / `fallback_tools` | control-plane tool guidance             | `skill_load`, skill index, gateway subagent prompt assembly, gateway tool-surface narrowing |
| `execution_hints.cost_hint`                          | advisory surfaced metadata              | `skill_load` and skill index; no runtime budget decision unless a consumer is added         |

`selection` is optional. When present, it must declare at least one signal:
`when_to_use`, `examples`, `paths`, or `phases`. A skill with a directory-derived
`routing.scope` but no `selection` signals is loaded and inspectable but not
routable. There is no authored `routable` field.

`execution_hints` is optional. When present, each child field is optional.
Empty `preferred_tools: []` and `fallback_tools: []` normalize away. If no
`cost_hint` is authored, `skill_load` and the generated index display the
default cost hint as `medium`; that default is not an authored contract field.

`execution_hints.suggested_chains` is not supported. Workflow sequencing that
is not consumed by runtime code belongs in the skill markdown body.

Authoring vs runtime path semantics:

- `parseSkillDocument(...)` preserves authored resource strings exactly
- skill-local entries such as `references/foo.md` or `scripts/bar.py` are
  interpreted relative to the skill directory
- root-scoped entries such as `skills/project/shared/*.md` are interpreted
  relative to the discovered skill root
- the loaded runtime catalog resolves these resource entries to filesystem paths
  before exposing them through `runtime.inspect.skills.get(...)` or `skill_load`

`selection` is the stable skill-authored control-plane signal for skill-first
recommendation. It keeps selection ownership with the skill contract rather than
hardcoding per-skill routing heuristics in the gateway. Current authored fields
are:

- `selection.when_to_use`
  - concise natural-language intent statement for when the skill should own the task
- `selection.examples`
  - optional task or user-utterance examples that make the selection intent concrete
- `selection.paths`
  - optional structured path hints used as path-aware boosts or penalties when explicit targets exist
- `selection.phases`
  - optional structured task-phase hints
  - vocabulary is closed and aligned to runtime `TaskPhase`:
    `align`, `investigate`, `execute`, `verify`, `ready_for_acceptance`, `blocked`, `done`

Operator and meta skills may omit `selection` when they are inspect-only. They
become routable only when routing is enabled, their directory-derived scope is
included, and `selection` carries at least one signal.

Runtime compiles internal selection features from authored `selection`,
`description`, and markdown trigger text at load time. Authors do not maintain a
second keyword-only routing table.

## Parameterizing Skill Invocations Via `task_set_spec`

Brewva's near-term parameterization model is TaskSpec-first rather than
contract-level `SkillContract.parameters`.

Use `task_set_spec` to make the invocation subject machine-readable:

- `goal`
  - the bounded job the active skill should own
- `expectedBehavior`
  - the semantic outcome or convergence posture the caller expects
- `constraints`
  - non-goals, hard limits, and explicit do-not-do boundaries
- `targets.files`
  - concrete repository scope for path-aware routing and later inspection
- `targets.symbols`
  - symbol-level subject when the invocation is about a named API, class, or
    workflow seam

This is the stable way to apply one skill procedure to different subjects
without widening the base skill contract.

Authoring guidance:

- write `selection.when_to_use` for the reusable procedure, not for one
  repository path
- expect callers to bind the current subject through TaskSpec, not through
  freeform prose alone
- prefer structured `targets.files` / `targets.symbols` over burying scope in
  narrative prompt text when the subject is known up front
- use `expectedBehavior` and `constraints` to disambiguate two invocations of
  the same skill that share a goal shape but differ in safety or completion
  posture

Interactive hosted routing already scores against `TaskSpec.goal`,
`expectedBehavior`, `constraints`, and explicit targets. Strengthening TaskSpec
usage is therefore the current path for invocation parameterization.

For non-overlay skills:

- both `resources.default_lease` and `resources.hard_ceiling` are required
- `resources.hard_ceiling` must stay greater than or equal to
  `resources.default_lease`
- `effects.allowed_effects: []` is treated as an explicit zero-effect boundary,
  not as implicit read-only fallback

Directory layout derives category and routing scope:

- `skills/core/*` -> `category=core`, `routing.scope=core`
- `skills/domain/*` -> `category=domain`, `routing.scope=domain`
- `skills/operator/*` -> `category=operator`, `routing.scope=operator`
- `skills/meta/*` -> `category=meta`, `routing.scope=meta`
- `skills/internal/*` -> internal only, not routable
- `skills/project/overlays/*` -> overlay only, not routable

`tier` and `category` frontmatter are rejected. Category is directory-derived.
Routing scope is also directory-derived, but scope alone does not make a skill
routable.

Non-overlay skill names must be globally unique across all loaded roots and
categories. Same-name specialization belongs in `skills/project/overlays/*`,
not in a second base skill definition that relies on load order.

`skills/internal/` is currently a reserved documentation slot for runtime-owned
workflow or recovery semantics. Verification, finishing, recovery, and
compose-style workflow assistance live in runtime/control-plane code today rather than
structured `SKILL.md` documents.

`intent.output_contracts` makes producer-boundary requirements explicit in the
skill contract instead of hiding them inside runtime heuristics. For ordinary
authored outputs, non-overlay skills with declared outputs must define a
contract for every output. For semantic-bound outputs, authors must declare
`intent.semantic_bindings`, but those bindings name canonical normalized
consumer schemas rather than producer-side exact-shape obligations. Authored
`intent.output_contracts` must not duplicate semantic-bound outputs. Overlays
may inherit base output contracts, but they cannot silently replace an
existing base output contract.

Stable producer/consumer rule:

- producer completion validates required output presence, authored non-semantic
  `output_contracts`, and any Tier A safety or progression blockers
- semantic bindings identify runtime-owned normalized read models used by
  downstream consumers, `skill_load`, `workflow_status`, and inspect surfaces
- advisory drift in semantic-bound outputs should surface as normalization
  issues and blocking metadata, not as automatic producer-boundary contract
  failure, unless a declared Tier A consumer boundary requires exactness

Current output contract kinds are intentionally limited to `text`, `enum`, and
`json`. `json` contracts may also declare `required_fields` plus recursive
`item_contract` schemas when downstream consumers need arrays of strongly
typed objects instead of loose JSON blobs.

## Authored Behavior

Frontmatter is only half of skill quality. Strong skills also encode authored
behavior in the markdown body:

- role posture: what the specialist is optimizing for
- interaction protocol: when to ask, proceed, or re-ground
- decision protocol: how choices are ranked or classified
- handoff expectations: what each artifact must teach the next skill
- completion and escalation behavior: when to stop instead of guessing

This is intentionally prompt-side guidance, not kernel authority. Runtime
enforces contracts, policy, replay, and commitment boundaries; skill-authored
behavior improves specialist quality without creating a second control loop.

## Skill Outputs vs Final Answers

Skill output patterns and final-answer presentation are separate surfaces.

- Skill artifacts use `intent.output_contracts`, `intent.semantic_bindings`,
  templates, and examples when downstream tooling needs stable structure.
- General assistant final answers follow the canonical communication policy
  from the substrate system prompt.
- Project or skill guidance may add scenario-specific maps, but it should not
  redefine the global final-answer policy.
- `skills/meta/skill-authoring/references/output-patterns.md` remains a skill
  artifact authoring reference; it is not the authority for ordinary
  final-answer prose, tables, or diagrams.

## Routing Scopes And Profiles

This section covers stable routing enablement and activation boundaries.
Per-turn recommendation order, post-completion transitions, and canonical skill
chains live in `docs/reference/skill-routing.md`.

Skill discovery and deliberation remain separated from kernel commitment:

- deliberation layers may surface candidate sets, evidence, or packets that
  help the model choose skills
- runtime does not emit a dedicated durable `skill_routing_*` family in the
  default path
- activation remains explicit through `skill_load`
- the proposal boundary is reserved for `effect_commitment`, not for skill
  selection
- runtime does not run adaptive inference loops or online model reranking in
  the kernel path

Routing is disabled by default (`skills.routing.enabled=false`). When enabled,
`skills.routing.scopes` is the single explicit routing allowlist. Interactive
front doors may opt into `routingDefaultScopes=["core", "domain"]`;
that only turns routing on when config omitted `skills.routing.enabled`, and it
preserves explicit scope lists when they are present.

Interactive hosted turns may still inject a TaskSpec-first skill policy block
and narrow the pre-skill bootstrap surface after `task_set_spec`, but that
remains a control-plane steering aid rather than a second activation path.
Actual cold-start recommendation and warm-transition heuristics are documented
in `docs/reference/skill-routing.md`.

## Kernel vs Control Plane

The runtime kernel and the optional control plane have different jobs:

- kernel/runtime: activation state, output validation, evidence, replay, policy enforcement, and effect commitment
- control plane: optional candidate generation, selection assistance,
  delegation, artifact presentation, and model-assisted judging

`skills_index.json` carries the complete loaded-skill catalog instead of
only the routable subset. Each entry retains normalized contract metadata,
including `category`, `routingScope`, `outputs`, `requires`, `consumes`,
`composableWith`, derived `effectLevel`, `allowedEffects`, and the explicit flags and provenance
fields `routable`, `overlay`, `filePath`, `baseDir`, `projectGuidance`,
`source`, `rootDir`, optional `overlayOrigins`, and authored `selection`.
Whether a skill participates in routing is now expressed by the entry itself
instead of by presence or absence in the file.

`routable` is a generated inspect property derived from routing enablement,
allowed routing scopes, and authored `selection` signals. Authors never write a
`routable` field.

`skills_index.json` is a versioned inspect artifact (`schemaVersion=2`), not a
durable source of truth. Runtime may rebuild it at startup or through explicit
`runtime.maintain.skills.refresh(...)`.

## Model-Native Sequencing

Runtime no longer owns public skill chaining or cascade policy. Skill
sequencing is model-native: the active model may load, activate, complete, and
re-enter skills as needed, but the runtime does not expose a public chain-intent
state machine or automatic next-step progression surface.

This keeps the kernel boundary narrow:

- runtime owns durable skill activation/completion state
- runtime validates declared outputs and records replayable receipts
- model-side path choice decides whether to continue with another skill,
  verify, repair, or stop

Deliberation-side recovery flows such as debug or review may still publish
non-authoritative artifacts, but they do not create a second public
skill-sequencing API in the runtime.

One common delivery chain now present in the catalog is:

`repository-analysis -> discovery -> strategy-review -> learning-research -> design -> pre-implementation -> implementation -> review -> qa -> ship -> retro -> knowledge-capture`

This remains a prompt-side and control-plane convention. Runtime still owns
verification, replay, derived workflow status, and effect governance.

Naming note:

- `knowledge-capture` is the skill name in routing and lifecycle discussions
- `knowledge_capture` is the managed tool that materializes repository-native
  precedent records under `docs/solutions/**`

`planning_posture` is an upstream handoff output, not a standalone skill. It is
expected to exist before non-trivial `design`, typically from
`repository-analysis`, `strategy-review`, or `debugging`.

## Workflow Artifacts And Posture

Skill lifecycle remains the authoritative semantic contract boundary, but the
runtime now derives workflow-facing artifacts from completed skill outputs and
adjacent evidence signals.

Current derived workflow artifact sources include:

- `problem_frame` / `user_pains` / `scope_recommendation` -> `workflow.discovery`
- `strategy_review` / `scope_decision` / `strategic_risks` / `planning_posture` -> `workflow.strategy_review`
- `knowledge_brief` / `precedent_refs` / `preventive_checks` / `precedent_query_summary` / `precedent_consult_status` -> `workflow.learning_research`
- `design_spec` plus planning metadata such as `execution_mode_hint`,
  `risk_register`, and `implementation_targets` -> `workflow.design`
- `execution_plan` plus verification-intent metadata ->
  `workflow.execution_plan`
- `change_set` / `files_changed` and write markers -> `workflow.implementation`
- `review_report` / `review_findings` / `merge_decision` -> `workflow.review`
- delegated `QaSubagentOutcomeData` plus mirrored `qa_report` /
  `qa_findings` / `qa_verdict` / `qa_checks` -> `workflow.qa`
- verification outcomes -> `workflow.verification`
- `ship_report` / `release_checklist` / `ship_decision` -> `workflow.ship`
- `retro_summary` / `retro_findings` / `followup_recommendation` -> `workflow.retro`
- delegated patch adoption or failure -> `workflow.worker_patch`
- metric observations -> `workflow.iteration_metric`
- guard results -> `workflow.iteration_guard`

Important boundary rules:

- workflow artifacts are derived working-state projections, not a second
  commitment-memory authority
- workflow posture is advisory-only and does not create a kernel-owned stage
  DAG
- inspection remains explicit: use `workflow_status` or working projection
  surfaces when needed instead of default turn-time workflow injection
- models may choose any valid path unless governance or safety boundaries
  independently block it
- derived workflow state is visible by inspection, not by a hidden planner or
  next-step controller

Control-plane and operator surfaces may inspect this state through
`workflow_status` and working projection surfaces.

`workflow_status` also exposes advisory planning assurance posture such as
`plan_complete`, `plan_fresh`, `review_required`, `qa_required`, and
`unsatisfied_required_evidence`. Those fields stay inspectable rather than
turning planning or verification into hidden runtime choreography.

`planning_posture` may also be produced by `repository-analysis` or
`debugging`, but today it remains a carried handoff output and metadata field
rather than a dedicated workflow artifact kind.

Protocol skills may sit beside the common delivery chain without becoming
runtime-owned planners:

- `goal-loop` for bounded continuity plus objective iteration evidence
- `predict-review` for multi-perspective advisory debate before the next owner
  takes over
- `learning-research` for explicit planning-time proof of consult against the
  repository-native precedent layer
- `pre-implementation` for explicit scope, simplicity, and success-criteria
  gating before mutation work begins

Related control-plane products now sit beside those skills instead of hiding in
prompt-only behavior:

- `deliberation_memory` for explicit inspection of retained repository, user,
  agent, and loop memory artifacts
- `skill_promotion_inspect` for cached post-execution draft inspection
- `skill_promotion_review` for operator review decisions
- `skill_promotion_promote` for materializing review packets without live apply
- `optimization_continuity` for explicit inspection of loop continuation,
  convergence, escalation, and attention-worthy lineage state

## Public Routable Skills

### Core

- `repository-analysis`
- `discovery`
- `learning-research`
- `strategy-review`
- `design`
- `pre-implementation`
- `implementation`
- `debugging`
- `review`
- `qa`
- `ship`
- `retro`
- `knowledge-capture`

### Domain

- `agent-browser`
- `ci-iteration`
- `frontend-design`
- `github`
- `predict-review`
- `telegram`
- `structured-extraction`
- `goal-loop`

`goal-loop` should be treated as a bounded multi-run continuity skill with
explicit cadence, lineage-aware iteration-fact history, and objective
metric/guard evidence discipline. It is not a general-purpose implementation
skill.

`goal-loop` remains the protocol skill. Deliberation-owned continuity artifacts
are folded after execution and exposed through `optimization_continuity`; the
runtime still does not own loop strategy or choose the next experiment.

Deliberation-owned memory artifacts are likewise explicit. Hosted sessions may
inject them when relevant, but `deliberation_memory` remains the inspection
surface for reviewing retained artifacts, scores, and evidence.

`ci-iteration` is the bounded repair-loop skill for PR and CI closure work. It
keeps retry posture explicit through baseline snapshots, bounded iteration
plans, verification evidence, and concrete stop or handoff conditions.

`predict-review` is an advisory multi-perspective skill. It uses public
delegation tools and existing built-in agent specs / envelopes to generate
competing hypotheses, but it does not create runtime authority or bypass
verification.

Default delegated routing is intentionally narrower than the public skill list:

- `repository-analysis -> advisor (investigate)`
- `discovery -> advisor (investigate)`
- `debugging -> advisor (diagnose)`
- `design -> advisor (design)`
- `review -> advisor (review)`
- `qa -> qa`
- `implementation -> patch-worker`
- other delegated skills stay explicit-only unless a stable public mapping is
  documented

Two stable contract reminders matter for downstream delegation and workflow
posture:

- `design` is expected to emit the full planning handoff set:
  `design_spec`, `execution_plan`, `execution_mode_hint`, `risk_register`, and
  `implementation_targets`; advisor `design` consults inform this contract but
  do not replace parent-owned `design` completion
- planning handoff precision is consumer-driven:
  path-scoped implementation targets and required evidence stay blocking where
  downstream consumers need them, while taxonomy-only fields such as
  `risk_register.category` or `owner_lane` remain non-blocking normalization
  metadata
- `implementation` is expected to stay inside path-scoped
  `implementation_targets`; work that materially exceeds the planned boundary
  should hand control back to `design` instead of silently widening scope
- `implementation` may consume partial normalized planning outputs, but it may
  block explicitly when normalized `implementation_targets` do not resolve to a
  safe path-scoped owner boundary
- `review` treats fresh planning evidence as a first-class input; high-risk
  work cannot reach `merge_decision = "ready"` when that planning evidence is
  missing or stale after later workspace writes
- `qa_verdict = "pass"` requires executable evidence, at least one adversarial
  probe, coverage of plan-declared `required_evidence`, and no unresolved
  missing evidence, confidence gaps, or environment limits; canonical QA
  outcome data preserves `pass`, `fail`, and `inconclusive` rather than
  flattening them into prose
- every `qa_check` must preserve how the check was executed and what was
  actually observed; command-based checks carry `command`, `exitCode`, and
  `observedOutput`, while tool-driven checks carry `tool` and
  `observedOutput`; `artifactRefs` are supplemental replay evidence
- `review-operability` is the internal evidence-audit lane for rollback posture,
  missing probes, stale evidence, and operator burden; it is not a second QA
  executor

Precision tiers are stable contract vocabulary for semantic-bound outputs:

- Tier A
  - unresolved fields may block safe progression at the boundary where the
    decision is made
  - examples: path-scoped implementation ownership, approval-bearing artifacts,
    rollback-critical state, verification freshness when ship or merge depends
    on it
- Tier B
  - producer completion may accept the output, but a named downstream consumer
    may block if normalization leaves required fields unresolved
  - examples: `risk_register.required_evidence`,
    `execution_plan.verification_intent` when QA or workflow posture derives
    required checks from it
- Tier C
  - fields may improve summaries, metadata, or optional ranking, but they do
    not block producer completion or workflow progression
  - examples: fine-grained planning taxonomies such as `risk_register.category`
    and `owner_lane` when they are not themselves a deterministic gate

Consumer declaration rule:

- any consumer that may block on normalized semantic output must declare that
  requirement explicitly in runtime code
- inspect and workflow surfaces may read advisory fields without upgrading them
  into producer-side hard requirements

## Hidden-By-Default Skills

### Operator

- `runtime-forensics`
- `git-ops`

### Meta

- `skill-authoring`
- `self-improve`

These skills are loaded by the registry but excluded from standard routing
unless routing scopes explicitly include them.

`self-improve` remains a meta skill rather than a kernel optimizer. It may
inspect lineage-scoped iteration facts as evidence, but its outputs are still
improvement hypotheses and learning backlog artifacts rather than runtime
control state.

Promotion remains explicit. `self-improve` may help derive repeat-backed
lessons, but the split skill promotion tools are the governed paths that
inspect, review, and materialize those drafts.

Scheduled `self-improve` runs do not change that boundary. They are still
repeat-backed, proposal-only passes rather than autonomous skill-file writes.

## Project Overlays

- `repository-analysis`
- `design`
- `implementation`
- `debugging`
- `review`
- `runtime-forensics`

Overlays merge onto the base skill contract with project semantics:

- intent outputs merge additively with the base contract
- output contracts remain base-derived unless the overlay adds a brand-new output
- completion definitions merge field-by-field, so overlays may tighten
  `verification_level` without silently dropping inherited
  `required_evidence_kinds`
- allowed effects may tighten, and denied effects only accumulate
- resource ceilings and default leases only tighten, never relax
- execution hints may specialize planning guidance without changing kernel authority
- multiple overlays apply in deterministic root load order; within one root,
  overlay files are applied in lexical path order, and later overlays only
  tighten or replace fields according to the merge contract

Shared project guidance is applied independently of overlays. Runtime prepends
guidance in root load order and attaches each discovered project-guidance
document at most once per final loaded skill, even when multiple same-name
overlays merge across roots.

Config-layer `skills.overrides` remain tightening-only. Project guidance is
metadata-only Markdown under `skills/project/shared/*.md`. Each file must start
with exactly:

```yaml
---
strength: invariant | workflow_gate | preference | lookup
scope: non-empty-string
---
```

The `strength` and `scope` values are provenance/context labels only. They do
not affect routing, tool authorization, provider payloads, tool results,
replay, or persisted truth. Runtime strips this frontmatter before injecting
the Markdown body and exposes the labels through `projectGuidance`.

Shared project guidance currently includes:

- `anti-patterns`
- `critical-rules`
- `migration-priority-matrix`
- `package-boundaries`
- `runtime-artifacts`
- `source-map`
- `workflow-gates`

## Storage Convention

- `skills/core/<skill>/SKILL.md`
- `skills/domain/<skill>/SKILL.md`
- `skills/operator/<skill>/SKILL.md`
- `skills/meta/<skill>/SKILL.md`
- `skills/internal/<skill>/SKILL.md`
- `skills/project/shared/*.md`
- `skills/project/overlays/<skill>/SKILL.md`

Runtime discovery also accepts roots provided via `skills.roots`. A discovered
root may either contain a nested `skills/` directory or the category directories
directly.

Current root provenance values are:

- `system_root`
  - Brewva-managed bundled defaults installed under `<globalRoot>/skills/.system`
- `global_root`
  - user-managed global additions under `<globalRoot>/skills`
- `project_root`
  - workspace-root project skills under `<workspaceRoot>/.brewva/skills`
- `config_root`
  - explicit extra roots from `skills.roots`

There is still no second runtime-authoritative rules plane. `SKILL.md` remains
the authoritative file for skill behavior, selection, outputs, effect policy,
resource ceilings, and optional execution hints. Project guidance is a lighter
context surface for repo-local invariants, workflow gates, preferences, and
lookup maps; it is not policy authority.
