# Archived Research: Subagent Orchestration V2 Role Taxonomy And Trigger Governance

## Document Metadata

- Status: `archived`
- Owner: gateway, runtime, and tools maintainers
- Last reviewed: `2026-05-15`
- Promotion target:
  - `docs/research/decisions/subagent-orchestration-v2-role-taxonomy-and-trigger-governance.md`
  - `docs/guide/features.md`
  - `docs/guide/orchestration.md`
  - `docs/journeys/operator/background-and-parallelism.md`
  - `docs/reference/skills.md`
  - `docs/reference/tools.md`
  - `docs/reference/tools/delegation.md`
  - `docs/reference/events/README.md`
- Archived on: `2026-05-15`
- Superseded by:
  - `docs/research/decisions/subagent-orchestration-v2-role-taxonomy-and-trigger-governance.md`

## Archive Summary

This RFC is archived because the Subagent Orchestration V2 contract is now
accepted and carried by stable docs, code, and tests.

The accepted shape replaces the earlier public specialist vocabulary with five
role-first subagent identities:

- `navigator`
- `explorer`
- `worker`
- `verifier`
- `librarian`

The RFC contributed four durable boundaries:

- `agent` is the public trigger, while `skillName` is an optional compatible
  semantic contract.
- Role, result mode, execution envelope, managed-tool set, model category, and
  adoption contract must remain aligned.
- Task path, nickname, `forkTurns`, gate reason, and model route are
  inspectable v3 record facts, not hidden prompt-only state.
- Knowledge proposals are advisory until the parent records an explicit
  adoption receipt that points at an authoritative artifact path.

The implementation intentionally did not accept hidden team mode, child-to-child
messaging, sibling delivery, or silent knowledge promotion.

## Read These Instead

- `docs/research/decisions/subagent-orchestration-v2-role-taxonomy-and-trigger-governance.md`
- `docs/reference/tools/delegation.md`
- `docs/guide/orchestration.md`
- `docs/reference/skills.md`
- `docs/journeys/operator/background-and-parallelism.md`

## Why Keep This File

Keep this note only to explain why Brewva split the old delegated specialist
surface into explicit public roles. The current contract lives in stable docs,
code, and the accepted decision record.
