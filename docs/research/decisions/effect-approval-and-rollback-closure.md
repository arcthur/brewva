# Decision: Effect Approval And Rollback Closure

## Metadata

- Decision: Approval-bound effect authority closes over exactly one committed effect as a single kernel-owned transaction — replay-derived approval state, a canonical versioned argument digest, lazy receipt-backed expiry, one canonical decision writer, and a default receipt-aware patch rollback lifecycle.
- Date: `2026-06-17`
- Status: accepted
- Stable docs:
  - `docs/journeys/operator/approval-and-rollback.md`
  - `docs/reference/proposal-boundary.md`
  - `docs/reference/tools.md`
  - `docs/reference/events/tools.md`
  - `docs/architecture/exploration-and-effect-governance.md`
- Code anchors:
  - `packages/brewva-runtime/src/runtime/kernel/impl.ts`
  - `packages/brewva-std/src/tool-call-digest.ts`
  - `packages/brewva-tools/src/patch-lifecycle/rollback.ts`
  - `packages/brewva-tools/src/families/workflow/rollback-last-patch.ts`
  - `packages/brewva-cli/src/entry/main.ts`

## Decision Summary

- Approval-bound authority closes over exactly one committed effect; the kernel
  derives approval posture from tape (no process-local pending map is
  load-bearing) and enforces it at every authority touch and at commit.
- Accepted approval binds one canonical call identity; argument identity is a
  canonical versioned digest (`stable-json-sha256/v1`), computed by one shared
  module and exposed separately from the request id.
- Denied, cancelled, expired, and digest-mismatched commitments terminalize with
  durable `tool.aborted` receipts and cannot commit a result.
- One canonical decision writer records the first durable decision; later
  concurrent decisions resolve to durable no-op receipts.
- `approval.expiresAt` restricts when execution may start, never whether a begun
  execution may finish; expiry is lazy and receipt-backed (a `tool.started`
  gate), with no background timer.
- Consumed posture is replay-derived from an accepted approval plus its linked
  `tool.committed`; no separate consumed event was added.
- Rollback is a default receipt-aware lifecycle over tracked `PatchSet`s with
  explicit `no_patchset` / `rollback_artifact_missing` / `conflict` /
  `partial_failure` states; CLI `--undo` and `rollback_last_patch` converge on
  one lifecycle across two recovery planes.
- Operator and integration surfaces are projections over receipts and never
  widen authority; fitness tests freeze the no-second-authority constraints and
  the digest stability vectors.

## Axioms

This decision is judged against `docs/architecture/design-axioms.md`:

- Obeys axiom 4 (Govern effects, not thought paths): authority binds the
  effectful commit, not the model's reasoning.
- Obeys axiom 5 (Every commitment has a receipt): approval request and decision,
  commit, abort, expiry, and rollback each produce durable receipts.
- Obeys axiom 6 (Tape is commitment memory): approval posture and consumed state
  are replay-derived from tape, not from a process-local map.
- Obeys axiom 11 (Same evidence is not shared authority): operator and
  integration projections and advisory mirrors never bear decision authority;
  only the kernel decides.
- Obeys axiom 8 (Graceful degradation beats hidden cleverness): rollback reports
  explicit failure states instead of implying a universal undo.
