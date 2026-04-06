# Research: Effect Governance and Contract vNext

## Document Metadata

- Status: `archived`
- Owner: runtime maintainers
- Last reviewed: `2026-04-06`
- Promotion target:
  - `docs/architecture/exploration-and-effect-governance.md`
  - `docs/reference/skills.md`
  - `docs/reference/runtime.md`
  - `docs/reference/configuration.md`
  - `docs/reference/tools.md`

## Archive Summary

This note is archived as a completed migration and rationale record. The
architecture and runtime surfaces described here have already been promoted
into stable docs and implemented in the current runtime.

The lasting decisions were:

- governance should be expressed primarily in terms of intent, effects, and
  completion evidence
- tool allowlists, denylists, and budgets are important controls, but they are
  not the whole meaning of the contract
- effect metadata and authorization stay repo-owned and replay-aware
- resource prescription belongs closer to planner policy than to the kernel's
  core authority boundary

## Current Contract

Read current behavior from:

- `docs/architecture/exploration-and-effect-governance.md`
- `docs/reference/skills.md`
- `docs/reference/runtime.md`
- `docs/reference/configuration.md`
- `docs/reference/tools.md`

Current stable docs and code now carry the contract that this RFC argued for:

- effect-boundary governance instead of tool-name-only meaning
- explicit runtime and tool reference surfaces for receipts, rollback, and
  authorization
- documented config semantics for governance-related behavior

## Why Keep This Note

This archive remains useful when you need the historical rationale for:

- demoting heavy path prescription from the center of `SkillContract`
- explaining why the runtime distinguishes effect governance from planner hints
- tracing why stable docs emphasize effect classes, evidence, and replay-safe
  authorization semantics

## Historical Notes

- Full proposal text, intermediate interface sketches, and rollout sequencing
  were removed from the archive-era main file.
- Use git history if you need the original draft detail or superseded contract
  alternatives.
