# Reference: Proposal Boundary

Boundary contract sources:

- Runtime types: `packages/brewva-runtime/src/types.ts`
- Runtime facade: `packages/brewva-runtime/src/runtime.ts`
- Proposal admission: `packages/brewva-runtime/src/services/proposal-admission.ts`
- Effect-commitment admission: `packages/brewva-runtime/src/services/proposal-admission-effect-commitment.ts`
- Operator desk: `packages/brewva-runtime/src/services/effect-commitment-desk.ts`

The public proposal boundary is now intentionally small.

Current rule:

- the only proposal kind is `effect_commitment`
- skill routing is not a proposal boundary
- context shaping is not a proposal boundary

This keeps the kernel boundary focused on one question:

`May this effectful action proceed?`

## Authority Model

- producers may submit a proposal
- kernel may `accept`, `reject`, or `defer`
- only accepted proposals may create approval-bearing commitments
- every decision is durable and replayable from tape

There is no fallback path that silently recreates approval state in memory.

## Core Objects

### `EvidenceRef`

Minimum fields:

- `id`
- `sourceType`
- `locator`
- `createdAt`

Optional field:

- `hash`

`EvidenceRef` captures provenance. It does not itself authorize anything.

### `ProposalEnvelope`

Fields:

- `id`
- `kind`
- `issuer`
- `subject`
- `payload`
- `evidenceRefs`
- `confidence?`
- `expiresAt?`
- `createdAt`

Current proposal kind:

- `effect_commitment`

### `DecisionReceipt`

Fields:

- `proposalId`
- `decision`
- `policyBasis`
- `reasons`
- `committedEffects`
- `evidenceRefs`
- `turn`
- `timestamp`

`DecisionReceipt` is the durable kernel answer. Replay, operators, and recovery
logic should inspect receipts rather than process-local state.

## `effect_commitment`

Producer intent:

- record an approval-bearing request for an `effectful` tool call
- keep the request auditable before the effect executes

Typical cases:

- `local_exec`
- `schedule_mutation`
- external network or side-effecting tools that require operator approval

Accepted effect:

- kernel creates a replayable pending approval request
- operator approval is recorded through the effect-commitment desk
- the caller must resume the exact request with
  `runtime.tools.start({ ..., effectCommitmentRequestId })`
- approval is consumed only after a durable linked tool result is recorded

This means the commitment path is explicitly at-least-once across crashes after
the external effect but before durable observation. Backends should therefore
use the request id as an idempotency key whenever possible.

## Admission Rules

Current admission is conservative:

- `id`, `issuer`, and `subject` are required
- at least one `EvidenceRef` is required
- expired proposals are rejected
- `payload.toolName` is required
- `payload.toolCallId` is required
- `payload.argsDigest` is required
- `payload.boundary` must be `effectful`
- the tool must have an exact governance descriptor
- the tool must actually require approval under that descriptor
- the declared `effects` must match the governance descriptor

Decision meanings:

- `accept`: pending approval-bearing commitment created
- `reject`: invalid or disallowed
- `defer`: recorded, but not yet committed

## Direct Commit Boundary

Not every effectful action becomes a proposal.

Direct kernel execution still applies to:

- `safe` tools
- `effectful` tools that are rollbackable but not approval-bound
- internal runtime bookkeeping that does not cross an external authority boundary

The proposal boundary exists only for approval-bearing effect commitment.

## Tape Mapping

Every proposal round leaves this replayable shape:

- `proposal_received`
- `proposal_decided`
- `decision_receipt_recorded`

Approval state is layered on top through:

- `effect_commitment_approval_requested`
- `effect_commitment_approval_decided`
- `effect_commitment_approval_consumed`

`runtime.proposals.list(sessionId, query?)` returns newest-first proposal
records by receipt timestamp.

The operator desk surface lives in the same domain:

- `runtime.proposals.listPendingEffectCommitments(sessionId)`
- `runtime.proposals.decideEffectCommitment(sessionId, requestId, input)`
- `runtime.tools.start({ ..., effectCommitmentRequestId })`

This keeps approval state and proposal history in one replay-first namespace.

- never mutate authoritative state without a receipt-worthy reason
- keep `policyBasis` and `reasons` readable by operators
- prefer explicit deferral over opaque fallback behavior
