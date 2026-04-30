# Research: Skill Surface Compression And Project Guidance Boundaries

## Document Metadata

- Status: `promoted`
- Owner: runtime and gateway maintainers
- Last reviewed: `2026-04-21`
- Promotion target:
  - `docs/reference/skills.md`
  - `docs/reference/skill-routing.md`
  - `docs/reference/runtime-plugins.md`
  - `docs/guide/category-and-skills.md`
  - `docs/architecture/system-architecture.md`

## Promotion Summary

This note is now a promoted status pointer.

The accepted decision is:

- skill authoring is compressed by making `selection` and `execution_hints`
  optional instead of required boilerplate
- routability is always derived from routing enablement, allowed routing scope,
  and the presence of at least one `selection.*` signal
- there is no authored `routable` field
- `skills_index.json` is a generated v2 inspect artifact; `routable` is
  generated and `projectGuidance` replaces the removed `sharedContextFiles`
  shape
- project guidance uses exactly two metadata-only fields, `strength` and
  `scope`
- project guidance is context/provenance metadata, not runtime policy
- `AGENTS.md` is a short repository map, hard-invariant summary, workflow
  trigger index, and verification summary; detailed workflow, lookup, and
  anti-pattern guidance belongs in `skills/project/shared/*.md`
- overlays remain skill-specific tightening surfaces and must not become the
  fallback home for global repo preferences
- future surface-affecting RFC promotion requires before/after surface-budget
  counts and runtime/gateway maintainer review

## Stable References

- `docs/reference/skills.md`
- `docs/reference/skill-routing.md`
- `docs/reference/runtime-plugins.md`
- `docs/guide/category-and-skills.md`
- `docs/architecture/system-architecture.md`
- `docs/research/README.md`
- `AGENTS.md`

## Stable Contract Summary

1. Loadable skills may omit `selection`. Missing `selection` makes the skill
   loaded and inspectable but not routable.
2. `selection.when_to_use` is not required. Any non-empty
   `selection.when_to_use`, `selection.paths`, or authored `## Trigger` signal
   is enough for routing eligibility when scope is enabled. The later promoted
   lifecycle-profile subtraction removed `selection.examples` and
   `selection.phases` from the authored contract.
3. `execution_hints` is optional. Empty `preferred_tools` and `fallback_tools`
   normalize away. Omitted `cost_hint` reads as `medium` through
   `getSkillCostHint(...)`.
4. Removed routing fields, legacy camelCase fields, and
   `execution_hints.suggested_chains` still fail closed.
5. Project guidance files must live under `skills/project/shared/*.md` and must
   begin with metadata-only frontmatter:
   - `strength: invariant | workflow_gate | preference | lookup`
   - `scope: <non-empty string>`
6. Runtime parses only `strength` and `scope`, strips the frontmatter before
   injection, and exposes the parsed labels as `projectGuidance`.
7. Project guidance metadata cannot route skills, select tools, grant or deny
   tool authority, alter provider payloads, rewrite tool results, or become
   replay or persisted truth.
8. Runtime prepends shared project guidance to final loaded skills
   independently of overlays. Guidance headings are demoted during injection so
   a guidance-local `## Trigger` cannot become skill-first routing prose.
9. `AGENTS.md` compression follows this concrete section-to-layer map:

| `AGENTS.md` section      | Retained layer                           | Extracted or supporting layer                                                                                                                                         |
| ------------------------ | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Purpose`                | `AGENTS.md` repository map               | none                                                                                                                                                                  |
| `Repo At A Glance`       | `AGENTS.md` map                          | `skills/project/shared/source-map.md` for expanded lookup                                                                                                             |
| `Hard Invariants`        | short `AGENTS.md` summary                | `docs/architecture/system-architecture.md`, `docs/reference/**`, `skills/project/shared/critical-rules.md`, `skills/project/shared/package-boundaries.md`, code/tests |
| `Workflow Trigger Index` | trigger names in `AGENTS.md`             | `skills/project/shared/workflow-gates.md`, package scripts, CI definitions                                                                                            |
| `Verification`           | canonical command summary in `AGENTS.md` | `skills/project/shared/workflow-gates.md`, `package.json`, `script/**`, CI definitions                                                                                |
| `Where To Look`          | compact pointer set in `AGENTS.md`       | `skills/project/shared/source-map.md`, stable reference docs                                                                                                          |
| `Anti-Patterns`          | no long-form list in `AGENTS.md`         | `skills/project/shared/anti-patterns.md`, invariant docs/tests when enforceable                                                                                       |

## Parser Boundary

The structural boundary is enforced in code, not only in documentation:

- `packages/brewva-runtime/src/skills/registry.ts` parses project guidance
  frontmatter, rejects unknown fields, applies guidance after final skill load,
  and demotes guidance headings before injection
- `skills/meta/skill-authoring/scripts/quick_validate.py` validates the same
  `strength` / `scope` metadata shape for authoring workflows
- `skills/project/scripts/check-skill-dod.sh` checks shared guidance metadata
  and rejects obvious overlay leakage of global repo guidance
- `test/contract/runtime/skills-discovery.contract.test.ts` covers derived
  routability, project guidance metadata, final-skill guidance injection, and
  guidance heading demotion
- `test/contract/runtime/skill-creator-quick-validate.contract.test.ts` covers
  quick validator alignment with runtime guidance parsing

## Surface Budget Outcome

Accepted deltas:

- minimal non-routable required skill fields: `8 -> 5`
- minimal routable required skill fields: `8 -> 6`
- project guidance metadata fields: `0 -> 2`
- author-facing concepts: `6 -> 5`
- routing/control-plane decision points: `5 -> 3`
- inspect surfaces: `1 -> 1`, replacing shared context attachment with
  `projectGuidance`

The only positive field delta is `strength` and `scope`. The debt owner is
runtime/gateway maintainers. The re-evaluation trigger is any future change
that consumes project guidance metadata for routing, tool authority, provider
payload shaping, tool-result shaping, replay, or persisted truth.

## Validation Status

Promotion is backed by:

- runtime parser and registry tests for optional `selection`,
  optional `execution_hints`, derived routability, and project guidance metadata
- gateway/tool tests proving `skill_load` separates routing scope from
  routability and defaults omitted tool guidance
- authoring validator tests for compressed skills and project guidance headers
- docs quality coverage for surface-budget workflow requirements and coverage
  of skill/project guidance names
- project skill DoD checks for metadata-only guidance headers and overlay leak
  guardrails
- full repository verification with `bun run check`, `bun test`,
  `bun run test:docs`, `bun run format:docs:check`, and `bun run test:dist`

## Historical Notes

- Earlier RFCs contracted dangerous surfaces, but they did not compress the
  product model. This promotion closes that gap by making the surface budget a
  promotion gate and shrinking skill boilerplate directly.
- The stable contract now lives in reference docs, runtime parser behavior,
  authoring validators, generated inspect artifacts, and repository guidance
  gates rather than in `docs/research/active/`.
