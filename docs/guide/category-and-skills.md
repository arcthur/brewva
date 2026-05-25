# Category And Skills

This guide explains how the skill catalog is organized after skills were
reduced to advisory SkillCards. It focuses on catalog layout and the separation
between skill context and capability authority. For the authoritative skill list
and contract details, use
`docs/reference/skills.md`.

## Current Layout

- Core advisory skills: `skills/core`
- Domain advisory skills: `skills/domain`
- Operator skills: `skills/operator`
- Meta skills: `skills/meta`
- Reserved internal skills: `skills/internal`
- Shared project guidance: `skills/project/shared`
- Project overlays: `skills/project/overlays`

Category is directory-derived. The catalog does not use a separate lifecycle
tier naming scheme.

## Semantic Roles

The important distinction is semantic:

- public skill: advisory instruction and selection context
- runtime or control-plane workflow semantics: not public skills
- project overlay: project-specific tightening plus project guidance
- operator and meta skills: loaded catalog entries, explicit or specialist use

Skills should remain behavior-rich, not just contract-rich. Frontmatter defines
advisory selection and resource references; the Markdown body still teaches the
model how the specialist reasons, decides, asks questions, and hands work off.
Outputs live in producer contracts. External actions live in capability
manifests and tool policy.

## Selection And Authority

Skill selection is not authorization. A SkillCard can make advisory context easy
to find, but it cannot expose a SaaS account, CLI, MCP server, write action, or
external side effect.

The runtime accepts only these SkillCard fields:

- `name`
- `description`
- `selection.when_to_use`
- `selection.path_globs`
- `references`
- `scripts`
- `invariants`

Capability manifests are the authority plane. They are selected separately and
record durable selection receipts. `skills.routing` and runtime routing scopes
are removed.

Current capability selection is deterministic: explicit target, policy default,
then selection-field ranking. Embedding ranking and LLM fallback remain reserved
RFC stages and do not expose authority in the promoted implementation.

Bounded or advisory protocol skills should still be used narrowly. For example:

- `goal-loop` is not a generic implementation fallback
- `predict-review` is not a generic replacement for `review`
- `learning-research` is the explicit precedent-consult posture before
  non-trivial planning or review

## Reading The Catalog

At a high level, the families map like this:

- core: delivery and engineering lifecycle surfaces such as
  `repository-analysis`, `office-hours`, `architecture`, `plan`,
  `implementation`, `review`, `verifier`, and `ship`
- domain: specialized environments and bounded protocols such as
  `agent-browser`, `github`, `telegram`, `extract`, and
  `goal-loop`
- operator: runtime and repository operations such as `runtime-forensics` and
  `git`
- meta: authoring and learning surfaces such as `skill-authoring` and
  `self-improve`

Project overlays specialize a subset of public skills for this repository.
Shared project guidance is injected centrally from `skills/project/shared`.

The current shared guidance files are `anti-patterns`, `critical-rules`,
`migration-priority-matrix`, `package-boundaries`, `runtime-artifacts`,
`source-map`, and `workflow-gates`.

Use `docs/reference/skills.md` when you need the exact current inventory rather
than examples.

## Overlay Semantics

Project overlays do not create new semantic territory. They:

- add project-specific advisory tightening
- add resource references, scripts, invariants, or body guidance
- cannot add authority fields, tool effects, resource budgets, or output
  contracts

Runtime prepends shared project guidance from `skills/project/shared` to final
loaded skills in root order, with each shared document injected at most once per
skill. This happens independently of whether a skill has a project overlay.

Shared project guidance files must use metadata-only frontmatter with
`strength`, `scope`, `convention_kind`, `retirement_sensitivity`, and optional
`owner`. Runtime strips that frontmatter before injection and uses it only for
provenance and convention-lifecycle labels; it does not grant or deny tool
authority, change routing, alter provider payloads, mutate tool results, or
affect replay.

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
- `packages/brewva-vocabulary/src/session.ts`
