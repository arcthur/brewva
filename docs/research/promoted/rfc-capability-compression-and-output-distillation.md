# Research: Capability Compression and Output Distillation

## Document Metadata

- Status: `promoted`
- Owner: runtime maintainers
- Last reviewed: `2026-03-02`
- Promotion target:
  - `docs/reference/runtime.md`
  - `docs/reference/runtime-plugins.md`
  - `docs/reference/events.md`
  - `docs/reference/tools.md`
  - `docs/architecture/system-architecture.md`

## Promotion Summary

This note is now a short status pointer.

The output-side distillation path has been promoted to stable documentation and implementation:

- tool output artifact persistence
- tool output distillation events
- distilled-output context injection source
- output search over persisted artifacts
- gateway/CLI display behavior aligned with distilled summaries

Stable references:

- `docs/reference/runtime.md`
- `docs/reference/runtime-plugins.md`
- `docs/reference/events.md`
- `docs/reference/tools.md`
- `docs/architecture/system-architecture.md`

## Remaining Backlog: Capability Compression (Definition-Side)

Definition-side compression (`capability_search` / `capability_execute`) is intentionally kept as backlog and is **not** part of current stable contracts.

Current rationale:

- Current tool cardinality and skill-dispatch filtering do not justify the additional protocol and governance complexity.
- Output-side compression already addresses the immediate context-budget pressure.

Adoption gate for future implementation:

1. Tool or MCP capability cardinality grows enough that tool-definition tokens become a material prompt budget share.
2. Existing explicit-tool routing quality degrades under high-cardinality domains.
3. Replay/audit constraints can be met with catalog versioning and explicit capability execution records.

## Historical Notes

- Historical proposal details were intentionally removed from this file after partial promotion.
- Future capability-compression work should start from a new focused research note when the adoption gate is met.
