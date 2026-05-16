# Archive: Interactive Command Surface Refinement

## Document Metadata

- Status: `archived`
- Owner: CLI, runtime, and gateway maintainers
- Last reviewed: `2026-05-16`
- Promotion target:
  - `docs/research/decisions/interactive-command-surface-refinement.md`

## Historical Summary

This archive note records the long-form RFC that narrowed Brewva's interactive
command surface around context, authority, diff/export evidence, skills, and
project guidance initialization. The accepted decision is now
`docs/research/decisions/interactive-command-surface-refinement.md`.

The RFC settled these constraints:

- keep the slash namespace flat and reserve confusing names instead of adding
  compatibility aliases
- make `/context`, `/authority`, and `/skills` read-only inspection veneers
- keep manual compaction behind a view-local or command-palette action
- reject `/permissions`, `/review`, and `/security-review` as built-in shell
  commands
- make `/diff` and `/export` bounded evidence surfaces backed by replay-visible state
- keep `/init` read-only until a confirmation flow owns file writes

The stable command, runtime, skills, and operator journey docs now carry the
normative contract.
