# Decision: Capability Selection And Authority Isolation

## Metadata

- Decision: Skills are advisory SkillCards; external authority is selected through a separate deterministic capability plane and enforced by scoped tool exposure plus runtime effect governance.
- Date: `2026-05-16`
- Status: accepted
- Stable docs:
  - `docs/architecture/exploration-and-effect-governance.md`
  - `docs/reference/configuration.md`
  - `docs/reference/hosted-dynamic-context.md`
  - `docs/reference/mcp-integration.md`
  - `docs/reference/proposal-boundary.md`
  - `docs/reference/skill-routing.md`
  - `docs/reference/skills.md`
  - `docs/reference/tools.md`
  - `docs/reference/events/README.md`
- Code anchors:
  - `packages/brewva-capabilities/src/index.ts`
  - `packages/brewva-runtime/src/domain/capabilities/**`
  - `packages/brewva-runtime/src/domain/skills/contract.ts`
  - `packages/brewva-runtime/src/domain/skills/producers.ts`
  - `packages/brewva-gateway/src/hosted/internal/session/tools/capability-selection.ts`
  - `packages/brewva-gateway/src/hosted/internal/session/tools/tool-surface.ts`
  - `packages/brewva-gateway/src/hosted/internal/session/tools/quality-gate.ts`
  - `packages/brewva-mcp-adapter/src/index.ts`
  - `packages/brewva-cli/src/io/skills-migrate.ts`
  - `test/contract/runtime/skill-card-producer-refactor.contract.test.ts`
  - `test/unit/capabilities/capability-selector.unit.test.ts`
  - `test/unit/gateway/hosted-behavior/tool-surface.unit.test.ts`
  - `test/unit/gateway/hosted-behavior/quality-gate.unit.test.ts`
  - `test/unit/mcp-adapter/mcp-adapter-pool.unit.test.ts`
  - `test/unit/cli/skills-migrate.unit.test.ts`

## Decision Summary

- `SKILL.md` is a compact advisory `SkillCard`. Removed authority and lifecycle fields fail fast in every skill root instead of being ignored or compatibility-normalized.
- Structured producer outputs live in `skills/producers/<name>.yaml`, keyed by producer name. Producer contracts are not prompt authority and do not activate a skill.
- Capability manifests live in `@brewva/brewva-capabilities`, separate from skills, tools, and MCP transport code. They describe authority inventory, not model instructions.
- The promoted selector is deterministic-only: explicit target, policy default within scope, then deterministic filters and selection-field ranking. Embedding ranking and LLM fallback are reserved and inactive; if deterministic selection yields no capability, no external authority is exposed.
- Capability selection records durable `capability_selection_recorded` events. Tool-only turns carry the previous receipt instead of re-ranking.
- Hosted context physically separates advisory skill cards from `[CapabilitySelection]`. `/skill:name` can load advisory context only; `/capability:name` or an equivalent trusted target is required before external authority can become visible.
- Hosted tool exposure and the quality gate use the latest selected capability receipt. Operator tools and gated external CLI/MCP actions remain hidden or blocked without matching selected capability evidence.
- MCP stdio execution uses allowlist semantics. `inheritEnv` is fixed to `false`; only explicit config `env` entries and `envAllowlist` keys are passed to the child process.
- Effect governance remains the final authority. Capability selection supplies replayable facts and receipt ids; action policy and proposal admission still decide allow, block, defer, approval, and recovery posture.
- Provider-specific SaaS proxy implementations, embedding ranking, and LLM fallback are not accepted authority paths in this decision. Future work must implement them on the same manifest, receipt, env-allowlist, and action-gate model before enabling them.

## Superseded by

- None.
