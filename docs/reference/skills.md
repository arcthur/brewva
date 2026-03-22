# Reference: Skills

Skill parsing, merge, and runtime-facing lifecycle logic:

- `packages/brewva-runtime/src/skills/contract.ts`
- `packages/brewva-runtime/src/skills/registry.ts`
- `packages/brewva-runtime/src/services/skill-lifecycle.ts`
- `packages/brewva-gateway/src/runtime-plugins/context-transform.ts`

## Current Model

Skill taxonomy is now split by role:

- public routable skills: routable semantic territory
- runtime/control-plane phases: workflow semantics, not public skills
- project overlays: project-specific tightening, execution guidance, and shared-context extension
- operator/meta skills: loaded, but usually hidden from standard routing

This keeps lifecycle choreography out of the public catalog.

## Skills vs Subagents

Skills and subagents solve different problems and stay intentionally separate.

- `skill`
  - semantic contract for the work
  - expected outputs, effect ceilings, completion rules, and budget ceilings
- `subagent profile`
  - isolated execution strategy for a delegated slice of work
  - model/tool surface narrowing, result mode, and boundary defaults

Current rules:

- a child run may preload or prefer one or more skills, but it does not create
  a second authoritative skill lifecycle by default
- the parent session remains the authority that owns active skill state,
  completion, and patch adoption
- patch-producing child runs return `WorkerResult` / patch artifacts for the
  parent-controlled `worker_results_merge` -> `worker_results_apply` flow

## Contract Metadata

Skill frontmatter supports intent, effect, resource, and execution metadata:

- `dispatch.suggest_threshold/auto_threshold`
- `intent.outputs/intent.output_contracts`
- `effects.allowed_effects/effects.denied_effects`
- `resources.default_lease/resources.hard_ceiling`
- `execution_hints.preferred_tools/execution_hints.fallback_tools/execution_hints.cost_hint`
- resource lists: `references`, `scripts`, `heuristics`, `invariants`

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

Non-overlay skill names must be globally unique across all loaded roots and
categories. Same-name specialization belongs in `skills/project/overlays/*`,
not in a second base skill definition that relies on load order.

`skills/internal/` is currently a reserved documentation slot for runtime-owned
phases. Verification, finishing, recovery, and compose-style planning live in
runtime/control-plane code today rather than structured `SKILL.md` documents.

`intent.output_contracts` makes artifact quality explicit in the skill contract
instead of hiding it inside runtime heuristics. Non-overlay skills with
declared outputs must define a contract for every output. Overlays may inherit
base output contracts, but they cannot silently replace an existing base output
contract.

Current output contract kinds are intentionally limited to `text`, `enum`, and
`json`.

## Routing Scopes And Profiles

Skill discovery and deliberation are now separated from kernel commitment:

1. Deliberation layers may rank skills, judge candidates, and suggest the next step.
2. Runtime emits `skill_routing_*` telemetry for that reasoning path.
3. Activation remains explicit through `skill_load`.
4. The proposal boundary is reserved for `effect_commitment`, not for skill selection.
5. Runtime does not run adaptive inference loops or online model reranking in the kernel path.

Routing is disabled by default (`skills.routing.enabled=false`). When enabled,
`skills.routing.scopes` is the single explicit routing allowlist.

## Kernel vs Control Plane

The runtime kernel and the optional control plane have different jobs:

- kernel/runtime: activation state, output validation, evidence, replay, policy enforcement, and effect commitment
- control plane: optional candidate generation, selection assistance, chain planning, delegation, and model-assisted judging

`skills_index.json` carries normalized contract metadata for each routable skill
entry, including `category`, `routingScope`, `outputs`, `requires`, `consumes`,
derived `effectLevel`, `allowedEffects`, and `dispatch`.

## Model-Native Sequencing

Runtime no longer owns public skill chaining or cascade policy. Skill
sequencing is model-native: the active model may load, activate, complete, and
re-enter skills as needed, but the runtime does not expose a public chain-intent
state machine or automatic next-step progression surface.

This keeps the kernel boundary narrow:

- runtime owns durable skill activation/completion state
- runtime validates declared outputs and records replayable receipts
- model-side planning decides whether to continue with another skill, verify,
  repair, or stop

Deliberation-side recovery flows such as debug or review may still publish
non-authoritative artifacts, but they do not create a second public
skill-sequencing API in the runtime.

## Workflow Artifacts And Readiness

Skill lifecycle remains the authoritative semantic contract boundary, but the
runtime now derives workflow-facing artifacts from completed skill outputs and
adjacent evidence signals.

Current derived workflow artifact sources include:

- `design_spec` -> `workflow.design`
- `execution_plan` -> `workflow.execution_plan`
- `change_set` / `files_changed` and write markers -> `workflow.implementation`
- `review_report` / `review_findings` / `merge_decision` -> `workflow.review`
- verification outcomes -> `workflow.verification`
- delegated patch adoption or failure -> `workflow.worker_patch`

Important boundary rules:

- workflow artifacts are derived working-state projections, not a second
  commitment-memory authority
- workflow readiness is advisory-only and does not create a kernel-owned stage
  DAG
- models may ignore a suggested next step and choose another valid path unless
  governance or safety boundaries independently block it

Control-plane and operator surfaces may inspect this state through
`workflow_status` and the default `[WorkflowAdvisory]` context source.

## Public Routable Skills

### Core

- `repository-analysis`
- `design`
- `implementation`
- `debugging`
- `review`

### Domain

- `agent-browser`
- `frontend-design`
- `github`
- `telegram`
- `structured-extraction`
- `goal-loop`

`goal-loop` should be treated as a bounded multi-run skill, not a
general-purpose implementation skill.

## Hidden-By-Default Skills

### Operator

- `runtime-forensics`
- `git-ops`

### Meta

- `skill-authoring`
- `self-improve`

These skills are loaded by the registry but excluded from standard routing
unless routing scopes explicitly include them.

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

Config-layer `skills.overrides` remain tightening-only. Shared project context is
prepended from:

- `critical-rules`
- `migration-priority-matrix`
- `package-boundaries`
- `runtime-artifacts`

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
