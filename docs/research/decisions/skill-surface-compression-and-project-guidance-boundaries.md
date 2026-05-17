# Decision: Skill Surface Compression And Project Guidance Boundaries

## Metadata

- Decision: Loadable skills may omit `selection`. Missing `selection` makes the skill loaded and inspectable; model-native routing still sees its name, description, and file path.
- Date: `2026-04-21`
- Status: accepted
- Stable docs:
  - `docs/reference/skills.md`
  - `docs/reference/skill-routing.md`
  - `docs/reference/extensions.md`
  - `docs/guide/category-and-skills.md`
  - `docs/architecture/system-architecture.md`
- Code anchors:
  - `script/**`
  - `packages/brewva-runtime/src/domain/skills/registry.ts`
  - `test/contract/runtime/skills-discovery.contract.test.ts`
  - `test/contract/runtime/skill-creator-quick-validate.contract.test.ts`

## Decision Summary

- Loadable skills may omit `selection`. Missing `selection` makes the skill loaded and inspectable; model-native routing still sees its name, description, and file path.
- `selection.when_to_use` is optional advisory text rendered beside the description. The hosted lifecycle no longer scores `selection.triggers`, `selection.path_globs`, authored trigger bullets, removed alias fields, or keyword overlap for cold-start skill selection.
- `execution_hints` is optional. Empty `preferred_tools` and `fallback_tools` normalize away. Omitted `cost_hint` reads as `medium` through `getSkillCostHint(...)`.
- Removed routing fields, legacy camelCase fields, and `execution_hints.suggested_chains` still fail closed.
- Project guidance files must live under `skills/project/shared/*.md` and must begin with metadata-only frontmatter: `strength: invariant | workflow_gate | preference | lookup` `scope: <non-empty string>`

## Superseded by

- `docs/research/decisions/model-operated-working-memory-and-context-governance-reset.md`
- `docs/research/decisions/capability-selection-and-authority-isolation.md`
