# Research Docs (Incubation Layer)

`docs/research/` is the incubation layer for cross-cutting ideas that are not
yet stable enough for `docs/architecture/` or `docs/reference/`.

## When to add a research note

- A decision spans multiple packages or runtime domains.
- The team needs to compare alternatives before locking a contract.
- Validation criteria are known, but implementation is still evolving.

## Required metadata for each research note

- `Status`: `proposed` | `active` | `promoted` | `archived`
- `Owner`: responsible team or maintainer group
- `Last reviewed`: date in `YYYY-MM-DD`
- `Promotion target`: destination stable document(s)

## Required sections for each research note

- Problem statement and scope boundaries
- Hypotheses or decision options
- Source anchors (code and docs paths)
- Validation signals (tests, metrics, or operational checks)
- Promotion criteria and destination docs

## Promotion workflow

1. Track open questions and hypotheses in `docs/research/*.md`.
2. Validate with code changes, tests, and operational evidence.
3. Promote accepted decisions into stable docs:
   - `docs/architecture/` for design/invariant decisions
   - `docs/reference/` for public contracts
   - `docs/journeys/` for operator workflows
4. Keep research pages as concise status pointers or archive them.

## Active notes

- `docs/research/rfc-architecture-doc-precision-review.md`
- `docs/research/rfc-boundary-first-subtraction-and-model-native-recovery.md`
- `docs/research/roadmap-notes.md`

## Promoted notes (status pointers)

- `docs/research/rfc-effect-governance-and-contract-vnext.md`
- `docs/research/rfc-capability-compression-and-output-distillation.md`
- `docs/research/rfc-subagent-delegation-and-isolated-execution.md`
- `docs/research/rfc-preparse-normalization-model-capability-and-live-audit-split.md`
- `docs/research/rfc-repository-fitness-plane-and-runtime-boundary.md`
- `docs/research/rfc-workflow-artifacts-and-posture-control-plane.md`
- `docs/research/rfc-iteration-facts-and-model-native-optimization-protocols.md`
- `docs/research/rfc-default-path-re-hardening-and-advisory-surface-narrowing.md`

## Archived / superseded notes

- `docs/research/rfc-invocation-spine-and-posture-runtime-vnext.md`
- `docs/research/rfc-runtime-decomposition-and-deliberation-thickening.md`
