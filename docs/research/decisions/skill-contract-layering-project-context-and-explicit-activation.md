# Decision: Skill Contract Layering, Project Context, And Explicit Activation

## Metadata

- Decision: Historical skill lifecycle authority was removed from the runtime public root. Current runtime skills ownership is catalog inspection and operator refresh; execution evidence is committed through the owning task, verification, and tool surfaces.
- Date: `2026-04-10`
- Status: accepted
- Stable docs:
  - `docs/architecture/system-architecture.md`
  - `docs/reference/skills.md`
  - `docs/reference/runtime.md`
  - `docs/reference/extensions.md`
  - `docs/reference/tools.md`
- Code anchors:
  - `N/A`

## Decision Summary

- Historical note: `authority.skills.complete(...)` and `inspect.skills.validateOutputs(...)` no longer exist. Runtime skill APIs now own catalog reads and refresh only.
- Runtime-owned evidence freshness remains enforced by task, verification, tool, event, and ledger boundaries. Callers do not get a standalone skill lifecycle authority path.
- Semantic-bound validation is mandatory runtime behavior for semantic-bound skills. It is not a hosted plugin and not a config-injected extension point.
- Skill execution lifecycle state no longer owns a public runtime domain authority surface. Validator implementations and evidence derivation live behind the owning workflow surfaces.
- `skills/project/shared/*.md` and project overlays remain the project convention plane. They can supplement context or tighten skill contracts, but they do not grant new tool authority or introduce a second authored rules catalog.

## Superseded by

- `docs/research/decisions/model-operated-working-memory-and-context-governance-reset.md`
- `docs/research/decisions/runtime-public-root-compression.md`
