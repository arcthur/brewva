# Decision: Action Policy Registry And Least-Privilege Governance

## Metadata

- Decision: runtime governance owns the `ActionPolicyRegistry`
- Date: `2026-04-20`
- Status: accepted
- Stable docs:
  - `docs/architecture/exploration-and-effect-governance.md`
  - `docs/architecture/invariants-and-reliability.md`
  - `docs/reference/configuration.md`
  - `docs/reference/context-composer.md`
  - `docs/reference/events/README.md`
  - `docs/reference/proposal-boundary.md`
  - `docs/reference/runtime.md`
  - `docs/reference/tools.md`
- Code anchors:
  - `packages/brewva-runtime/src/domain/governance/action-policy.ts`
  - `packages/brewva-runtime/src/security/command-policy.ts`

## Decision Summary

- runtime governance owns the `ActionPolicyRegistry`
- tools declare semantic `actionClass` values instead of authoring public governance descriptors
- the runtime derives execution descriptors for the existing approval and rollback spine
- admission, receipts, recovery, sandbox posture, and budget weight are properties of action policy, not separate author-facing policy surfaces
- runtime capabilities remain independent from action policy and stay declared by managed tools

## Superseded by

- None.
