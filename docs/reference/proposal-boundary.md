# Reference: Proposal Boundary

Boundary contract sources:

- Runtime contracts: `packages/brewva-runtime/src/contracts/index.ts`
- Runtime facade: `packages/brewva-runtime/src/runtime.ts`
- Proposal admission: `packages/brewva-runtime/src/services/proposal-admission.ts`
- Effect-commitment admission: `packages/brewva-runtime/src/services/proposal-admission-effect-commitment.ts`
- Operator desk: `packages/brewva-runtime/src/services/effect-commitment-desk.ts`

The public proposal boundary is now intentionally small.

This page owns approval-bearing commitment semantics and replay-visible receipt
flow. Public runtime surface listing stays in `docs/reference/runtime.md`, and
the event-family catalog stays in `docs/reference/events.md`.

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

### `EffectCommitmentProposal`

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

This is the only public proposal shape.

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

Current flow:

- initial admission normally returns `defer` and creates a replayable pending
  approval request
- operator approval is recorded through the effect-commitment desk
- the caller must then resume the exact request with
  `runtime.authority.tools.start({ ..., effectCommitmentRequestId })`
- exact resume binds to the approved `requestId`, original `toolCallId`, and
  canonical `argsDigest`
- only that approved exact-resume path returns `accept`
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
- the tool must have an exact or registry-backed governance descriptor; regex
  hints are not sufficient for admission
- the tool must actually require approval under that descriptor
- the declared `effects` must match the governance descriptor

Decision meanings:

- `accept`: an existing approved request matched exact resume and may proceed;
  this does not create a new pending approval request
- `reject`: invalid, disallowed, rejected by the operator desk, already
  consumed, or mismatched on exact resume
- `defer`: durable pending approval-bearing commitment exists, but it is not
  yet approved for exact resume

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

`runtime.inspect.proposals.list(sessionId, query?)` returns newest-first
`EffectCommitmentRecord` values by receipt timestamp. The read model rebuilds
those records from `decision_receipt_recorded.payload = { proposal, receipt }`
rather than rejoining `proposal_received` and `proposal_decided`.

Request-state views are intentionally separate:

- `listEffectCommitmentRequests(sessionId, query?)` is the normalized
  request-lifecycle view ordered by `updatedAt` descending
- `listPendingEffectCommitments(sessionId)` is the pending-only queue ordered
  by request `createdAt` descending

The operator desk surface lives in the same domain:

- `runtime.inspect.proposals.listEffectCommitmentRequests(sessionId, query?)`
- `runtime.inspect.proposals.listPendingEffectCommitments(sessionId)`
- `runtime.authority.proposals.decideEffectCommitment(sessionId, requestId, input)`
- `runtime.authority.tools.start({ ..., effectCommitmentRequestId })`

This keeps approval state and proposal history in one replay-first namespace.

- never mutate authoritative state without a receipt-worthy reason
- keep `policyBasis` and `reasons` readable by operators
- prefer explicit deferral over opaque fallback behavior
