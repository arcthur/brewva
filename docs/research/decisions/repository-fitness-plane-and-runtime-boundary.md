# Decision: Repository Fitness Plane and Runtime Boundary

## Metadata

- Decision: Brewva distinguishes `runtime commitment` from `repository fitness` as two adjacent planes rather than one merged trust system.
- Date: `2026-03-23`
- Status: accepted
- Stable docs:
  - `docs/architecture/system-architecture.md`
  - `docs/architecture/design-axioms.md`
  - `docs/architecture/exploration-and-effect-governance.md`
  - `docs/architecture/cognitive-product-architecture.md`
- Code anchors:
  - `packages/brewva-runtime/src/internal/legacy-runtime/kernel/verification/verification.ts`
  - `packages/brewva-runtime/src/internal/legacy-runtime/kernel/tools/tool-authorizer.ts`
  - `packages/brewva-tools/src/families/workflow/workflow-status.ts`

## Decision Summary

- Brewva distinguishes `runtime commitment` from `repository fitness` as two adjacent planes rather than one merged trust system.
- The kernel governs effects, approvals, receipts, replay, rollback, and verification evidence freshness for the active runtime session.
- Repository merge or release trust stays outside kernel ownership by default.
- Session-local workflow posture and `workflow_status` remain advisory surfaces, not merge or release authority.
- External repository-fitness evidence may feed Brewva only as explicit, imported judgment rather than as hidden kernel scope creep.

## Superseded by

- `docs/research/decisions/four-port-runtime-simplification-rfc.md`
