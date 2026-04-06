# Research: Invocation Spine, Posture Policy, and Injection Shaping vNext

## Document Metadata

- Status: `archived`
- Owner: runtime maintainers
- Last reviewed: `2026-04-06`
- Promotion target:
  - `docs/architecture/exploration-and-effect-governance.md`
  - `docs/architecture/control-and-data-flow.md`
  - `docs/reference/runtime.md`
  - `docs/reference/context-composer.md`
  - `docs/reference/events.md`

## Archive Summary

This note is archived because its implementation work largely landed, but its
top-level vocabulary is no longer the current public contract.

What survived:

- shared invocation recording remains a core runtime invariant
- governance still concentrates at the effect boundary rather than across every
  thought-path step
- injection shaping remains a runtime-owned concern with explicit context
  boundaries
- receipt-aware rollback and event recording remain first-class

What did not survive as the public model:

- the RFC's three-posture contract (`observe`, `reversible_mutate`,
  `commitment`)
- progressive trust as a lasting user-facing architecture boundary
- exploration-supervision framing as an active design goal

## Current Contract

Read current behavior from:

- `docs/architecture/exploration-and-effect-governance.md`
- `docs/architecture/control-and-data-flow.md`
- `docs/reference/runtime.md`
- `docs/reference/context-composer.md`
- `docs/reference/events.md`
- `docs/research/promoted/rfc-boundary-first-subtraction-and-model-native-recovery.md`

The stable contract now speaks in terms of:

- shared invocation spine
- `safe` and `effectful` execution boundaries
- `effect_commitment` and receipt-bearing reversible mutation
- deterministic context composition and replay-aware event recording

## Why Keep This Note

This archive is still useful when you need to explain:

- why the repository separated shared invocation recording from authorization
  decisions
- why posture terminology disappeared from public runtime and subagent surfaces
- why newer boundary-first docs emphasize explicit boundary vocabulary over
  richer planner-lane taxonomies

## Historical Notes

- Detailed option analysis, phased rollout text, and superseded posture
  definitions were removed from the main file after archiving.
- Use git history if you need the full proposal-era reasoning or intermediate
  migration steps.
