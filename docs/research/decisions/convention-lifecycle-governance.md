# Decision: Convention Lifecycle Governance

## Metadata

- Decision: Convention lifecycle governance is a first-class runtime domain with claim vocabulary, shared evidence metadata, event-sourced state, review-desk admission, and approved reversible mutation application.
- Date: `2026-05-12`
- Status: accepted
- Stable docs:
  - `docs/architecture/cognitive-product-architecture.md`
  - `docs/architecture/exploration-and-effect-governance.md`
  - `docs/journeys/operator/approval-and-rollback.md`
  - `docs/reference/events/README.md`
  - `docs/reference/runtime.md`
  - `docs/reference/skills.md`
- Code anchors:
  - `packages/brewva-runtime/src/read-models/claim/api.ts`
  - `packages/brewva-vocabulary/src/iteration.ts`
  - `packages/brewva-runtime/src/domain/conventions/service.ts`
  - `packages/brewva-runtime/src/domain/conventions/runtime-surface.ts`
  - `packages/brewva-runtime/src/domain/conventions/target-writers.ts`
  - `packages/brewva-runtime/src/internal/legacy-runtime/kernel/governance/reversible-mutation.ts`
  - `packages/brewva-runtime/src/internal/legacy-runtime/model/skills/types.ts`
  - `packages/brewva-runtime/src/runtime/runtime.ts`

## Decision Summary

- The former runtime `truth` vocabulary is removed in favor of `claim`. There are no compatibility aliases, shim fields, or dual-write wire shapes.
- `EvidenceRef` is shared across proposal and convention governance and preserves diversity metadata through normalization, descriptors, clone reads, and replay-facing readers.
- Convention governance is separate from tool-effect proposal governance. `EffectCommitmentProposal` remains limited to `effect_commitment`, while convention promotion, retirement, contest, and mutation use `ConventionChangeRequest` and `ConventionDecisionReceipt`.
- Convention state is rebuilt from event tape. Claim ledger entries may expose inspectable operational claims, but they are not a second lifecycle authority.
- Approved convention mutations use first-class convention mutation receipts and target writers for registered writable surfaces only.
- Project guidance metadata carries convention strength, scope, kind, retirement sensitivity, and owner metadata where required; unsupported or missing frontmatter remains fail-closed.
- Automatic health, conflict, and substrate-change projectors are not part of this accepted foundation. Their reserved event producers remain deferred; historical rationale is archived under `docs/research/archive/convention-projectors-and-substrate-review.md`.

## Superseded by

- `docs/research/decisions/four-port-runtime-simplification-rfc.md`
