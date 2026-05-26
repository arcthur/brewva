# Reference: Proposal Boundary

Boundary contract sources:

- Runtime contracts: `packages/brewva-runtime/src/runtime/kernel/policy/public-contract.ts`
- Runtime facade: `packages/brewva-runtime/src/runtime/runtime.ts`
- Proposal admission: `packages/brewva-runtime/src/runtime/kernel/policy/tool-admission-policy.ts`
- Effect-commitment admission: `packages/brewva-runtime/src/runtime/kernel/policy/effect-posture.ts`
- Operator desk: `packages/brewva-runtime/src/runtime/kernel/impl.ts`

The public proposal boundary is now intentionally small.

This page owns approval-bearing commitment semantics and replay-visible receipt
flow. Public runtime surface listing stays in `docs/reference/runtime.md`, and
the event-family catalog stays in `docs/reference/events/README.md`.

Current rule:

- the only proposal kind is `effect_commitment`
- skill routing is not a proposal boundary
- capability selection is not a proposal boundary
- context shaping is not a proposal boundary
- operator safety is a projection over kernel authority and receipt evidence,
  not a second proposal or permission engine

This keeps the kernel boundary focused on one question:

`May this effectful action proceed?`

## Authority Model

- producers may submit a proposal
- kernel may `accept`, `reject`, or `defer`
- only accepted proposals may create approval-bearing commitments
- every decision is durable and replayable from tape

There is no fallback path that silently recreates approval state in memory.

Effect proposals share the same authority basis as direct tool execution.
`EffectAuthorityManifest` owns the approval requirement, receipt requirement,
and authority-basis explanation. Proposal admission owns waiting, resume,
delegation, request history, and operator-decision lifecycle. This split keeps
approval state replayable without creating a second effect-policy model.

Capability selection is an input fact to this authority model, not a proposal
kind. A selected capability receipt can explain why an external tool or
operator surface was visible, but proposal admission still decides whether an
approval-bearing effect commitment may proceed.

Both direct execution and proposal admission attach `manifestBasis` to their
decision receipts. A mismatch means the implementation has split authority and
must fail closed rather than silently reconciling divergent policy meanings.

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
- the caller must then resume the exact request through the capability-scoped
  hosted adapter tool invocation path:
  `HostedRuntimeAdapterPort.ops.tools.invocation.start({ ..., effectCommitmentRequestId })`
- exact resume binds to the approved `requestId`, original `toolCallId`, and
  canonical `argsDigest`
- exact resume reuses the original manifest authority basis; it does not
  recompute a different action-policy meaning during approval consumption
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
- the tool must have an exact or registry-backed action policy; regex
  hints are not sufficient for admission
- the tool must actually require approval under that action policy
- the declared `effects` must match the policy-derived execution descriptor

Decision meanings:

- `accept`: an existing approved request matched exact resume and may proceed;
  this does not create a new pending approval request
- `reject`: invalid, disallowed, rejected by the operator desk, already
  consumed, or mismatched on exact resume
- `defer`: durable pending approval-bearing commitment exists, but it is not
  yet approved for exact resume

Proposal admission and request-local operator decisions use different enums:

- proposal admission remains `accept`, `reject`, or `defer`
- operator request decision is `accept`, `deny`, or `cancel`
- request state is `pending`, `accepted`, `denied`, `cancelled`, or `consumed`

The split is intentional. Proposal admission answers whether a proposal can
enter or resume the commitment boundary. Operator request decision records what
the operator did for one pending ask. Neither path creates persistent
preferences, regex permissions, or reusable source approval state.

## Operator Safety Projection

Operator safety renders the existing authority facts as `Allow`, `Ask`, or
`Deny`:

- `Allow`: the kernel admitted the action and required evidence is present
- `Ask`: the kernel deferred the action or projection evidence is incomplete
- `Deny`: the kernel denied the action or durable evidence proves a narrower
  outcome

The pure projection API is exported from `@brewva/brewva-runtime/security`:

- `OperatorSafetyDecisionView`
- `SandboxPosture`
- `DenialReason`
- `projectOperatorSafetyDecision(...)`
- `renderOperatorSafetyDecision(...)`
- `renderOperatorSafetyRecoveryHint(...)`

Projection code lives under `packages/brewva-runtime/src/read-models/projection`
and may depend only on pure governance types and structured event inputs. It
must not import kernel ports, gateway adapters, provider code, or managed tool
families.

Projection invariants:

- kernel `deny` can only render `Deny`
- kernel `ask` can render `Ask` or narrower `Deny`
- missing projection evidence fails closed to `Ask`, unless durable kernel
  evidence is already `Deny`
- one `DenialReason` drives both operator text and model-facing recovery hints
- recovery hints are redacted and must not expose raw command, env, credential,
  or token text

## Direct Commit Boundary

Not every effectful action becomes a proposal.

Direct kernel execution still applies to:

- `safe` tools
- `effectful` tools whose action policy admits direct execution with an
  appropriate receipt and recovery policy
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
- canonical runtime events `approval.requested` and `approval.decided`

`HostedRuntimeAdapterPort.ops.proposals.proposals.list(sessionId, query?)` returns newest-first
`EffectCommitmentRecord` values by receipt timestamp. The read model rebuilds
those records from `decision_receipt_recorded.payload = { proposal, receipt }`
rather than rejoining `proposal_received` and `proposal_decided`.

Request-state views are intentionally separate:

- `HostedRuntimeAdapterPort.ops.proposals.requests.list(sessionId, query?)` is the
  normalized request-lifecycle view rebuilt from tape
- `HostedRuntimeAdapterPort.ops.proposals.requests.listPending(sessionId)` is the
  pending-only queue ordered by request `createdAt`

The operator desk surface lives in the same domain:

- `HostedRuntimeAdapterPort.ops.proposals.requests.list(sessionId, query?)`
- `HostedRuntimeAdapterPort.ops.proposals.requests.listPending(sessionId)`
- `HostedRuntimeAdapterPort.ops.proposals.requests.decide(sessionId, requestId, input)`
- `HostedRuntimeAdapterPort.ops.tools.invocation.start({ ..., effectCommitmentRequestId })`

This keeps approval state and proposal history in one replay-first namespace.

- never mutate authoritative state without a receipt-worthy reason
- keep `policyBasis` structured as an ordered list and render it only at the UI boundary
- prefer explicit deferral over opaque fallback behavior
