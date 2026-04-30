# Decision: Subagent Interface Depth And Review Ensemble Surface

## Metadata

- Decision: The public delegated specialist surface is stable and authority-shaped: `advisor`, `qa`, and `patch-worker`.
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

- The public delegated specialist surface is stable and authority-shaped: `advisor`, `qa`, and `patch-worker`.
- Public delegation is intent-first. Normal callers provide `skillName` and packet fields; the resolver derives agent spec, envelope, result kind, consult kind, context profile, visibility, model route, and adoption contract.
- Diagnostic delegation is physically separate. Maintainer-only `subagent_run_diagnostic` may specify low-level target and routing fields, but that path is not ordinary operator guidance.
- Review lanes are internal implementation detail behind the review ensemble. Lane identities may appear in internal or diagnostic inspection, but they do not widen the public specialist list.
- `plan` remains a parent-owned workflow. Delegated advisor design consults can inform planning artifacts, but the child does not own plan completion or patch adoption.

## Superseded by

- None.
