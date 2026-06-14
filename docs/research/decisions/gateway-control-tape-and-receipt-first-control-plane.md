# Decision: Gateway Control Tape And Receipt-First Control Plane

## Metadata

- Decision: Make the gateway control plane carry its own durable truth on an append-only control tape, and make `sessions.send` idempotent by client turn id.
- Date: `2026-06-13`
- Status: accepted
- Stable docs:
  - `docs/architecture/design-axioms.md`
  - `docs/journeys/operator/gateway-control-plane-lifecycle.md`
  - `docs/guide/gateway-control-plane-daemon.md`
  - `docs/reference/gateway-control-plane-protocol.md`
- Code anchors:
  - `packages/brewva-gateway/src/daemon/session-supervisor/control-tape.ts`
  - `packages/brewva-gateway/src/daemon/gateway-daemon.ts`

## Decision Summary

- Public-session replay binding resolves from `gateway_session_bound` receipts on the append-only `gateway-control.jsonl` control tape, not from a mutable JSON registry. The retired `session-bindings.json` (`brewva.gateway-session-bindings.v2`) is deleted, not toggled behind compatibility.
- Control-plane commitments are receipt-bearing: token rotation, stop, and scheduler pause/resume append durable receipts to the same control tape.
- `sessions.send` is conditionally idempotent by client `turnId` plus a prompt hash: a retry with the same prompt replays a durable `gateway_prompt_admitted` admission, while the same `turnId` with a different prompt is rejected as a `prompt_conflict` rather than silently dropped. Both the fresh and the in-flight-resolved paths record the admission receipt, so idempotency provenance is uniform.
- The gateway resolves admission idempotency from its own control tape, never by reading the agent runtime tape — control-plane truth stays on the control plane.
- `status.deep` returns an explicit `assessment.verdict` of `ok | inconclusive` instead of implying all-clear by the absence of errors.

## Boundaries

- The control tape is append-only. An interrupted append leaves an unterminated trailing fragment, which is truncated on recovery (it acknowledges no receipt); a newline-terminated malformed line is genuine corruption and fails loud.
- Admission idempotency is durable but not transactional with execution: if the `gateway_prompt_admitted` write fails on a genuine I/O error, that one turn falls back to the supervisor's in-flight turn-id guard. No compensation graph is introduced.
- Only `gateway_prompt_admitted` receipts compact: the tape is atomically rewritten to the most recent admissions (their value is purely recency), while every binding (replay authority) and operator receipt (audit) is retained. Binding lifecycle stays a data-plane concern — a binding is only ever dropped together with its archived agent tape, never by control-tape compaction.

## Axioms

This decision is judged against `docs/architecture/design-axioms.md`:

- Obeys axiom 6 (Tape is commitment memory): gateway bindings and control commitments are replayable receipts on an append-only tape, not rewritten JSON.
- Obeys axiom 5 (Every commitment has a receipt): rotate-token, stop, scheduler pause/resume, session bind, and prompt admission each produce an inspectable receipt.
- Obeys axiom 3 (Subtraction beats switches): the v2 JSON registry is deleted from the default path rather than kept behind a compatibility toggle.
- Obeys axiom 11 (Same evidence is not shared authority): gateway idempotency authority lives on the control plane and does not reach into runtime data-plane tapes.
- Obeys axiom 7 (Inconclusive is honest governance): `status.deep` reports `inconclusive` when a subsystem cannot yet be assessed, instead of a fake `ok`.
- Defers axiom 17 boundary: no cross-agent saga or compensation is introduced; the stable `single tool call` transaction boundary is unchanged.
