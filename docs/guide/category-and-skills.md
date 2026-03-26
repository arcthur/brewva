# Category And Skills

Skills are loaded by category, not by lifecycle tier.

## Current Layout

- Core capability skills: `skills/core`
- Domain capability skills: `skills/domain`
- Operator skills: `skills/operator`
- Meta skills: `skills/meta`
- Reserved internal skills: `skills/internal`
- Shared project context: `skills/project/shared`
- Project overlays: `skills/project/overlays`

The important distinction is semantic:

- public skill = routable capability boundary
- runtime/control-plane workflow semantics = not public skills
- project overlay = project-specific tightening plus shared context
- operator/meta = loaded, but hidden from standard routing by default

Skills should also remain behavior-rich, not just contract-rich. The frontmatter
defines runtime authority and artifact shape; the markdown body should still
teach the model how the specialist behaves, decides, asks questions, and hands
work off to the next skill.

## Routing Scopes

`skills.routing.enabled=false` by default. When enabled,
`skills.routing.scopes` is the only allowlist for auto routing visibility.
Typical defaults are `core` and `domain`; operator/meta stay loaded but hidden
unless scopes explicitly opt in.

Bounded or advisory protocol skills are still gated by routing context and
required artifacts. For example, `goal-loop` is not auto-routed for ordinary
one-shot implementation prompts, and `predict-review` is not a generic review
replacement.

## Current Inventory

- Core: `repository-analysis`, `discovery`, `strategy-review`, `design`, `implementation`, `debugging`, `review`, `qa`, `ship`, `retro`
- Domain: `agent-browser`, `frontend-design`, `github`, `telegram`, `structured-extraction`, `goal-loop`, `predict-review`
- Operator: `runtime-forensics`, `git-ops`
- Meta: `skill-authoring`, `self-improve`
- Overlays: `repository-analysis`, `design`, `implementation`, `debugging`, `review`, `runtime-forensics`
- Shared project context: `critical-rules`, `migration-priority-matrix`, `package-boundaries`, `runtime-artifacts`

Special protocol posture:

- `goal-loop` owns bounded continuity, explicit cadence, and objective
  iteration-fact discipline
- `predict-review` owns advisory multi-perspective debate and hypothesis
  ranking, not runtime authority
- `self-improve` mines repeated evidence into learning backlog items rather
  than acting as a hidden optimizer

One common software-delivery chain is:

`discovery -> strategy-review -> design -> implementation -> review -> qa -> ship -> retro`

This is a catalog convention, not a kernel-owned stage machine.

## Overlay Semantics

Project overlays do not create new semantic territory. They:

- can add project-specific execution hints and shared context
- tighten allowed/denied effects, resource ceilings, and routing constraints
- keep base outputs/consumes unless the overlay explicitly replaces them
- prepend shared project context from `skills/project/shared`

This keeps project knowledge centralized without turning every project into a new
catalog of public super-skills.

## Runtime-Owned Workflow Semantics

These are no longer public skills:

- verification
- finishing
- recovery
- compose-style workflow semantics

`skills/internal/` is intentionally reserved for future structured runtime
workflow or recovery docs. Today those runtime-owned semantics are implemented
in code, not as routable skills.

Skill configuration contract is defined in `packages/brewva-runtime/src/contracts/index.ts`
(`BrewvaConfig.skills`).
