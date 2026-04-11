# Category And Skills

This guide explains how the skill catalog is organized and how routing sees it.
It focuses on catalog layout and routing boundaries, not the exhaustive skill
inventory. For the authoritative skill list and contract details, use
`docs/reference/skills.md`.

## Current Layout

- Core capability skills: `skills/core`
- Domain capability skills: `skills/domain`
- Operator skills: `skills/operator`
- Meta skills: `skills/meta`
- Reserved internal skills: `skills/internal`
- Shared project context: `skills/project/shared`
- Project overlays: `skills/project/overlays`

Category is directory-derived. The catalog does not use a separate lifecycle
tier naming scheme.

## Semantic Roles

The important distinction is semantic:

- public skill: routable capability boundary
- runtime or control-plane workflow semantics: not public skills
- project overlay: project-specific tightening plus shared context
- operator and meta skills: loaded catalog entries, usually hidden from default
  routing scopes

Skills should remain behavior-rich, not just contract-rich. Frontmatter defines
authority, outputs, effects, and resources; the Markdown body still teaches the
model how the specialist reasons, decides, asks questions, and hands work off.

## Routing Scopes

`skills.routing.enabled=false` by default. When routing is enabled,
`skills.routing.scopes` is the explicit allowlist for auto-routing visibility.

Typical defaults are `core` and `domain`. Operator and meta skills remain
loaded but hidden unless scopes explicitly opt in.

Interactive hosted entrypoints may apply
`routingDefaultScopes=["core", "domain"]`; that default only activates when
config omitted `skills.routing.enabled`, and it does not replace explicit
`skills.routing.scopes`.

Bounded or advisory protocol skills are still gated by routing context and
required artifacts. For example:

- `goal-loop` is not a generic implementation fallback
- `predict-review` is not a generic replacement for `review`
- `learning-research` is the explicit precedent-consult posture before
  non-trivial planning or review

## Reading The Catalog

At a high level, the families map like this:

- core: delivery and engineering lifecycle surfaces such as
  `repository-analysis`, `design`, `implementation`, `review`, `qa`, and
  `ship`
- domain: specialized environments and bounded protocols such as
  `agent-browser`, `github`, `telegram`, `structured-extraction`, and
  `goal-loop`
- operator: runtime and repository operations such as `runtime-forensics` and
  `git-ops`
- meta: authoring and learning surfaces such as `skill-authoring` and
  `self-improve`

Project overlays specialize a subset of public skills for this repository.
Shared project context is injected centrally from `skills/project/shared`.

Use `docs/reference/skills.md` when you need the exact current inventory rather
than examples.

## Overlay Semantics

Project overlays do not create new semantic territory. They:

- add project-specific execution hints and shared context
- tighten allowed and denied effects, resource ceilings, and routing
  constraints
- keep base outputs and consumes unless the overlay explicitly replaces them
- prepend shared project context from `skills/project/shared` in root order,
  with each shared document injected at most once per final loaded skill

This keeps project knowledge centralized without turning every project into a
new catalog of public super-skills.

## Runtime-Owned Workflow Semantics

These are not public skills:

- verification
- finishing
- recovery
- compose-style workflow semantics

`skills/internal/` remains reserved for future structured runtime workflow or
recovery docs. Today those semantics are implemented in code, not as routable
skills.

## Related Docs

- `docs/guide/features.md`
- `docs/reference/skills.md`
- `docs/reference/skill-routing.md`
- `packages/brewva-runtime/src/contracts/index.ts`
