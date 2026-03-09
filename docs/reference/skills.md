# Reference: Skills

Skill parsing, merge, and selection logic:

- `packages/brewva-runtime/src/skills/contract.ts`
- `packages/brewva-runtime/src/skills/registry.ts`
- `packages/brewva-runtime/src/skills/dispatch.ts`
- `packages/brewva-extensions/src/context-transform.ts`

## V2 Model

Skill taxonomy is now split by role:

- public capability skills: routable semantic territory
- runtime/control-plane phases: workflow semantics, not public skills
- project overlays: project-specific tightening and resource extension
- operator/meta skills: loaded, but usually hidden from standard routing

This keeps lifecycle choreography out of the public catalog.

Automatic debug retry is now implemented as an extension-side controller that
reuses explicit cascade intents plus runtime verification outcomes; it is not a
public skill and not a runtime-kernel planner.

## Contract Metadata

Skill frontmatter supports routing- and artifact-focused metadata:

- `dispatch.gate_threshold/auto_threshold/default_mode`
- `routing.continuity_required`
- `outputs/requires/consumes/composable_with`
- `effect_level`
- resource lists: `references`, `scripts`, `heuristics`, `invariants`

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

Dispatch planning uses only `requires` as hard prerequisites; `consumes` remain
optional context for loading and scoring.

## Routing Scopes And Profiles

Selector execution is governance-first for runtime routing:

1. Runtime kernel routing is deterministic and contract-aware when `skills.selector.mode=deterministic`.
2. Explicit preselection (for example control-plane `setNextSelection`) is consumed before runtime routing and wins when present.
3. Routing telemetry emits `skill_routing_selection` and reflects the final runtime routing result (`selected | empty | failed`), plus `skipped` under the critical compaction gate.
4. `skills.selector.mode=external_only` disables kernel routing and keeps explicit preselection as the only selection source.
5. Activation remains explicit: routing may produce `suggest/gate/auto` dispatch decisions, but actual skill entry still happens through `skill_load`.
6. Runtime does not run adaptive inference loops or online model reranking in the kernel path.

Routing scope defaults are driven by `skills.routing.profile`:

- `standard`: `core`, `domain`
- `operator`: `core`, `domain`, `operator`
- `full`: `core`, `domain`, `operator`, `meta`

Skills marked `routing.continuity_required=true` are additionally gated by
continuity-aware dispatch context. This is how `goal-loop` avoids colliding with
ordinary single-run implementation work.

## Kernel vs Control Plane

The runtime kernel and the optional control plane have different jobs:

- kernel/runtime: deterministic routing, dispatch gates, evidence, replay, and policy enforcement
- control plane: optional preselection assistance such as the external catalog broker and its lexical or `llm` judge

When the broker path is enabled, runtime is forced to `external_only` and
consumes explicit preselection as an input. The model-assisted judge therefore
does not make the kernel "smarter"; it is a separate control-plane assist path.

`skills_index.json` carries normalized contract metadata for each routable skill
entry, including `category`, `routingScope`, `continuityRequired`, `outputs`,
`requires`, `consumes`, `effectLevel`, and `dispatch`.

## Cascade Orchestration

Skill cascading is policy-driven via `skills.cascade.*`:

- `mode=off`: no automatic cascade behavior
- `mode=assist`: runtime records/plans chains but waits for manual continuation
- `mode=auto`: runtime auto-advances to next steps after `skill_completed` events

Chain intent can come from:

- dispatch planning
- explicit `startCascade(...)` / `skill_chain_control`

Source arbitration uses:

- `skills.cascade.enabledSources` as allowlist
- `skills.cascade.sourcePriority` as ordering for enabled sources

Current built-in sources are only `dispatch` and `explicit`.

Runtime records cascade lifecycle as replayable events:

- `skill_cascade_planned`
- `skill_cascade_step_started`
- `skill_cascade_step_completed`
- `skill_cascade_paused`
- `skill_cascade_replanned`
- `skill_cascade_overridden`
- `skill_cascade_finished`
- `skill_cascade_aborted`

When step consumes are missing, cascade deterministically pauses
(`reason=missing_consumes`). Runtime no longer supports compose-originated chain
plans as a public source.

The debug loop reuses explicit cascade rather than introducing a second step
engine. Its failure snapshot and handoff packet are extension-owned artifacts,
not public skill outputs.

## Public Capability Skills

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

`goal-loop` is continuity-gated and should be treated as a bounded multi-run
capability, not a general-purpose implementation skill.

## Hidden-By-Default Skills

### Operator

- `runtime-forensics`
- `git-ops`

### Meta

- `skill-authoring`
- `self-improve`

These skills are loaded by the registry but excluded from standard routing
unless the routing profile/scopes explicitly include them.

## Project Overlays

- `repository-analysis`
- `design`
- `implementation`
- `debugging`
- `review`
- `runtime-forensics`

Overlays merge onto the base skill contract with project semantics:

- resources are additive
- project-required tools may be added
- denied tools and budgets still only tighten, never relax
- outputs/consumes remain base-derived unless the overlay explicitly replaces them

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
