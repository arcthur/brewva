# Decision: Skill Surface Compression And Project Guidance Boundaries

## Metadata

- Decision: Loadable skills may omit `selection`. Missing `selection` makes the skill loaded and inspectable but not routable.
- Date: `2026-04-21`
- Status: accepted
- Stable docs:
  - `docs/reference/skills.md`
  - `docs/reference/skill-routing.md`
  - `docs/reference/runtime-plugins.md`
  - `docs/guide/category-and-skills.md`
  - `docs/architecture/system-architecture.md`
- Code anchors:
  - `script/**`
  - `packages/brewva-runtime/src/skills/registry.ts`
  - `test/contract/runtime/skills-discovery.contract.test.ts`
  - `test/contract/runtime/skill-creator-quick-validate.contract.test.ts`

## Decision Summary

- Loadable skills may omit `selection`. Missing `selection` makes the skill loaded and inspectable but not routable.
- `selection.when_to_use` is not required. Any non-empty `selection.when_to_use`, `selection.paths`, or authored `## Trigger` signal is enough for routing eligibility when scope is enabled. The later promoted lifecycle-profile subtraction removed `selection.examples` and `selection.phases` from the authored contract.
- `execution_hints` is optional. Empty `preferred_tools` and `fallback_tools` normalize away. Omitted `cost_hint` reads as `medium` through `getSkillCostHint(...)`.
- Removed routing fields, legacy camelCase fields, and `execution_hints.suggested_chains` still fail closed.
- Project guidance files must live under `skills/project/shared/*.md` and must begin with metadata-only frontmatter: `strength: invariant | workflow_gate | preference | lookup` `scope: <non-empty string>`

## Superseded by

- None.
