# Decision: Model Interface Attention Contract

## Metadata

- Decision: Brewva model-facing context is typed, scoped, and turn-bounded while runtime authority remains receipt-governed.
- Date: `2026-05-20`
- Status: accepted
- Stable docs:
  - `docs/reference/hosted-dynamic-context.md`
  - `docs/reference/skill-routing.md`
  - `docs/reference/skills.md`
  - `docs/reference/tools/delegation.md`
  - `docs/architecture/cognitive-product-architecture.md`
- Code anchors:
  - `packages/brewva-substrate/src/prompt/system-prompt.ts`
  - `packages/brewva-substrate/src/resources/resource-loader.ts`
  - `packages/brewva-gateway/src/hosted/internal/session/managed-agent/tool-registry.ts`
  - `packages/brewva-gateway/src/hosted/internal/session/managed-agent/session.ts`
  - `packages/brewva-gateway/src/hosted/internal/session/skills/skill-selection.ts`
  - `packages/brewva-tools/src/families/delegation/subagent-run/api.ts`
  - `test/unit/substrate/system-prompt.unit.test.ts`
  - `test/unit/substrate/resource-loader.unit.test.ts`
  - `test/unit/gateway/hosted-behavior/skill-selection.unit.test.ts`

## Decision Summary

- The stable Brewva system prompt is represented internally as
  `BrewvaSystemPromptDocument` with ordered blocks carrying stability,
  authority, source references, and token estimates. Providers still receive
  rendered text.
- Brewva foundation blocks are not replaceable by custom instructions. Custom
  instructions are advisory session context appended after the operating,
  communication, and tool-policy contracts.
- Project instructions are structured `CLAUDE.md` / `AGENTS.md` files loaded in
  global, ancestor, and target-nested order. Target-path instructions are
  advisory prompt context and do not create mutation gates.
- SkillCards are deterministic, turn-scoped advisory shortlist context when
  candidates exist. The selector considers explicit `$skill` mention, path
  glob, trigger, name match, and description or `when_to_use` text match, then
  records prompt paths, candidate/render/omission counts, mode, reasons, and
  reason-count evidence. Empty shortlists are receipt-only and rely on the
  stable operating contract for optional `discover_skills` guidance.
- SkillCards still cannot grant tools, accounts, budgets, side effects, runtime
  authority, or completion requirements. Capability selection remains the
  authority receipt plane.
- Delegation guidance now separates local exact search from subagent roles:
  navigator for evidence, explorer for judgment, librarian for institutional
  knowledge, worker for isolated implementation, and verifier for non-trivial
  implementation checks. This does not change public delegation schemas or
  auto-spawn behavior.
- Working updates and final answers are modeled as product-facing communication
  obligations in the prompt contract, while kernel, tape, and capability
  consequences stay runtime-owned.

## Boundaries

- Do not reintroduce `buildBrewvaSystemPrompt(...)`,
  `formatBrewvaCapabilitySelectionForPrompt(...)`, or `getAgentsFiles(...)`.
- Do not render the full SkillCard catalog by default or truncate every
  description to fit a large all-skills prompt.
- Do not use SkillCard frontmatter as a capability, account, permission, budget,
  or side-effect authority source.
- Do not let target-path project instructions block read, edit, or write tools.
- Do not change subagent public schemas just to express cognitive routing.
