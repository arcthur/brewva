# Journey: Approval And Rollback

## Audience

- operators blocked by `tool_call` decisions who need to understand approval
  and rollback behavior
- developers reviewing governance, the proposal boundary, and the tool gate

## Entry Points

- blocked or deferred tool calls
- approval turns in channel mode
- `HostedRuntimeAdapterPort.ops.tools.access.explain(...)`
- `HostedRuntimeAdapterPort.ops.proposals.requests.list(...)`
- `HostedRuntimeAdapterPort.ops.proposals.requests.listPending(...)`
- `rollback_last_patch`

## Objective

Describe how an effectful tool invocation is classified by boundary,
commitment posture, and recovery preparation, and how an operator moves through
effect commitment, explicit approval, exact resume, and rollback surfaces.

## In Scope

- tool access and effect-boundary classification
- effect-commitment admission
- operator approval and exact resume
- anchored `SourcePatchPlan` apply and `PatchSet` rollback

## Out Of Scope

- normal interactive-session happy paths
- detached subagent merge
- scheduler daemon
- full inspect report composition

## Flow

```mermaid
flowchart TD
  A["Tool invocation"] --> B["KernelToolAuthorizer classifies boundary"]
  B --> C{"Boundary result"}
  C -->|Safe| D["Execute directly"]
  C -->|Effectful with source patch preparation| E["source_patch_apply records mutation receipt"]
  C -->|Effectful approval-bound| F["Create effect_commitment request"]
  F --> G["Operator desk / channel approval"]
  G --> H{"Decision"}
  H -->|Reject| I["Keep request denied or deferred"]
  H -->|Approve| J["Resume exact call with effectCommitmentRequestId"]
  J --> K["Record durable linked tool result"]
  K --> L["Consume approval"]
  E --> M{"Need rollback?"}
  M -->|Yes| N["rollback_last_patch or rollbackLastMutation(...)"]
  M -->|No| O["Continue session"]
```

## Key Steps

1. A tool invocation enters the shared invocation spine and resolves an exact
   governance descriptor.
2. The runtime classifies the call as:
   - `safe`
   - `effectful` with local recovery preparation
   - `effectful` and approval-bound
3. Approval-bound calls do not execute immediately; they create a replayable
   `effect_commitment` request.
4. The operator decides the request through the operator desk or a channel
   approval surface.
5. After approval, the caller must resume the exact request using the same
   `effectCommitmentRequestId`, original `toolCallId`, and canonical argument
   identity.
6. Approval is consumed only after a durable linked tool result is recorded.
7. Source mutations prepare a `SourcePatchPlan` before execution and only
   mutate through `source_patch_apply`. The result is reversible only after the
   recorded mutation receipt links a `PatchSet` and rollback artifact.

## Execution Semantics

- `effectful` does not mean "always requires approval"
- recovery preparation and approval-bound commitment are different effectful
  realities; a tool can need approval without having an automatic undo path
- approval never auto-applies to a later similar-looking call; only the exact
  request may be resumed, including the original `toolCallId` and `argsDigest`
- `resource_lease` expands budget only; it does not widen effect authority
- with `infrastructure.events.enabled=false`, effectful execution fails closed;
  the runtime does not permit a no-audit read-model write path

## Failure And Recovery

- proposal admission rejects requests without an exact governance descriptor,
  with mismatched declared effects, or for tools that are not actually
  approval-bound
- pending approval is replay-hydrated from tape after restart; there is no
  process-local fallback
- concurrent or late decisions resolve to the first durable decision on tape;
  later attempts stay recorded as no-op receipts and never change the outcome
- an approval-bound call may declare a closure bound (`approval.expiresAt`);
  the bound restricts when execution may start, never whether a begun
  execution may finish. Admission records a durable `tool.started` receipt;
  decisions recorded at or after the bound do not bind, and a request or
  acceptance with no pre-bound start receipt terminalizes as
  `approval_request_expired` at the next authority touch — lazily, with a
  durable abort receipt, never via a background timer
- if an external effect completes before durable observation is recorded, the
  path still carries at-least-once semantics; backends should treat the request
  id as an idempotency key whenever possible
- `rollback_last_patch` only covers tracked `PatchSet` artifacts, including
  source patches that recorded rollback artifacts during apply; it reports
  explicit `no_patchset`, `rollback_artifact_missing`, `conflict`, and
  `partial_failure` states instead of implying universal undo
- rollback preflight validates the simulated post-apply state per path before
  touching any file, so workspace drift surfaces as `conflict` with zero
  mutation
- `rollbackLastMutation(...)` is the receipt-aware rollback surface and returns
  an explicit no-candidate result when no rollback receipt exists

## Observability

- primary inspection and operator surfaces:
  - `HostedRuntimeAdapterPort.ops.tools.access.explain(...)`
  - `HostedRuntimeAdapterPort.ops.proposals.requests.list(...)`
  - `HostedRuntimeAdapterPort.ops.proposals.requests.listPending(...)`
  - `HostedRuntimeAdapterPort.ops.proposals.proposals.list(...)`
  - `brewva inspect`
- core durable events (operator-facing prose names map onto the runtime event
  family; the runtime names are the replay truth):
  - proposal admission receipts — runtime event `proposal.submitted` (carries
    the decision receipt)
  - `effect_commitment_approval_requested` — runtime event `approval.requested`
  - `effect_commitment_approval_decided` — runtime event `approval.decided`
  - `effect_commitment_approval_consumed` — replay-derived from an accepted
    approval plus its linked `tool.committed` result; there is no separate
    consumed event
  - proposed and committed effects — runtime events `tool.proposed`,
    `tool.committed`, and `tool.aborted` (terminal closure receipts, including
    `approval_request_expired`)
  - rollback evidence — runtime event `rollback.recorded`

## Code Pointers

- Proposal boundary: `docs/reference/proposal-boundary.md`
- Tool authorizer: `packages/brewva-runtime/src/runtime/kernel/impl.ts`
- Tool transaction log: `packages/brewva-runtime/src/runtime/kernel/impl.ts`
- Effect-commitment desk: `packages/brewva-runtime/src/runtime/kernel/impl.ts`
- `PatchSet` rollback: `@brewva/brewva-vocabulary/workbench`
- Source patch protocol: `@brewva/brewva-vocabulary/workbench`
- Source patch gate:
  `packages/brewva-tools/src/families/navigation/source-patch.ts`
- Receipt-aware rollback: `packages/brewva-runtime/src/runtime/kernel/impl.ts`
- Rollback tool: `packages/brewva-tools/src/families/workflow/rollback-last-patch.ts`

## Related Docs

- Exploration and effect governance: `docs/architecture/exploration-and-effect-governance.md`
- Proposal boundary: `docs/reference/proposal-boundary.md`
- Tools reference: `docs/reference/tools.md`
- Inspect / replay / undo: `docs/journeys/operator/inspect-replay-and-recovery.md`
