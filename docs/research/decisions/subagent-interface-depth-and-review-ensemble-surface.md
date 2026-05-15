# Decision: Subagent Interface Depth And Review Ensemble Surface

## Metadata

- Decision: Superseded. The public delegated specialist surface is now role-first under Subagent Orchestration V2.
- Date: `2026-04-30`
- Status: accepted
- Stable docs:
  - `docs/architecture/cognitive-product-architecture.md`
  - `docs/architecture/system-architecture.md`
  - `docs/reference/tools.md`
  - `docs/reference/skills.md`
  - `docs/guide/orchestration.md`
  - `docs/journeys/operator/background-and-parallelism.md`
- Code anchors:
  - `N/A`

## Decision Summary

- The public delegated specialist surface remains stable and authority-shaped, but it is now role-first: normal callers provide `agent`, optional `skillName`, task identity, and packet fields.
- Public delegation is intent-first. The resolver validates role, skill compatibility, gate reason, result mode, execution envelope, visibility, model route, and adoption contract without acting as a hidden scheduler.
- Diagnostic delegation remains physically separate. Maintainer-only `subagent_run_diagnostic` may specify low-level target and routing fields, but that path is not ordinary operator guidance.
- Review lanes are internal implementation detail behind the review ensemble. Lane identities may appear in internal or diagnostic inspection, but they do not widen the public specialist list.
- `plan` remains a parent-owned workflow. Delegated explorer design consults can inform planning artifacts, but the child does not own plan completion or patch adoption.

## Superseded by

- `docs/research/decisions/subagent-orchestration-v2-role-taxonomy-and-trigger-governance.md`
