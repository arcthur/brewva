# Research: Repository Fitness Plane and Runtime Boundary

## Document Metadata

- Status: `promoted`
- Owner: runtime maintainers
- Last reviewed: `2026-03-23`
- Promotion target:
  - `docs/architecture/system-architecture.md`
  - `docs/architecture/design-axioms.md`
  - `docs/architecture/exploration-and-effect-governance.md`
  - `docs/architecture/cognitive-product-architecture.md`
  - `README.md`

## Promotion Summary

This note is now a short status pointer.

Brewva now treats two adjacent trust planes as a stable architectural split:

- `runtime commitment plane`
  - governs what an agent run may do now
  - authorizes effects
  - records receipts
  - preserves replay, rollback, and verification evidence
- `repository fitness plane`
  - governs whether a repository change is ready to review, merge, release, or
    escalate
  - owns change-level gates, risk routing, deep validation, and
    human-review triggers

The promoted decision is that Brewva remains a commitment runtime. Repository
fitness is adjacent. Runtime verification, workflow posture, and `workflow_status`
must not silently expand into repository merge or release authority.

## Stable References

- `docs/architecture/system-architecture.md`
- `docs/architecture/design-axioms.md`
- `docs/architecture/exploration-and-effect-governance.md`
- `docs/architecture/cognitive-product-architecture.md`
- `README.md`
- `packages/brewva-runtime/src/services/verification.ts`
- `packages/brewva-runtime/src/services/tool-gate.ts`
- `packages/brewva-tools/src/workflow-status.ts`

## Stable Contract Summary

The promoted contract is:

1. Brewva distinguishes `runtime commitment` from `repository fitness` as two
   adjacent planes rather than one merged trust system.
2. The kernel governs effects, approvals, receipts, replay, rollback, and
   verification evidence freshness for the active runtime session.
3. Repository merge or release trust stays outside kernel ownership by default.
4. Session-local workflow posture and `workflow_status` remain advisory surfaces,
   not merge or release authority.
5. External repository-fitness evidence may feed Brewva only as explicit,
   imported judgment rather than as hidden kernel scope creep.

## Validation Status

Promotion is backed by:

- stable architecture docs that consistently describe the two-plane model
- top-level product framing that no longer conflates runtime verification with
  repository fitness
- runtime surface tightening from `readiness` to `posture`, including
  `ship_posture` and `workflow_status.details.posture`
- regression coverage for workflow-status contracts, workflow derivation, tape
  replay/recovery, and docs terminology guards

## Remaining Backlog

The following directions are intentionally not part of the promoted contract:

- declarative governance policy specs in repository docs rather than
  code-embedded policy logic
- repository-local fitness specs such as `docs/fitness/**`
- explicit repository-fitness inspection tools
- governance-port adapters that consume external fitness verdicts
- change-level evidence ledgers or review-trigger registries

If those areas become active product work, they should start from this boundary
instead of reopening kernel scope.

## Historical Notes

- Historical option analysis and terminology-hardening discussion were removed
  after promotion.
- The stable contract now lives in architecture, reference, README framing, and
  regression tests rather than in `docs/research/`.
