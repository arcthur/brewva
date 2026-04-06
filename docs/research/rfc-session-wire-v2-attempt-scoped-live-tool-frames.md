# Research: Session Wire V2 Attempt-Scoped Live Tool Frames

## Document Metadata

- Status: `archived`
- Owner: gateway and runtime maintainers
- Last reviewed: `2026-04-05`
- Promotion target:
  - `docs/reference/gateway-control-plane-protocol.md`
  - `docs/reference/runtime.md`
  - `docs/reference/events.md`
  - `docs/reference/session-lifecycle.md`

## Archive Summary

This focused RFC has been implemented and folded into stable docs plus the
promoted session-wire note.

Current contract:

- `brewva.session-wire.v2` is the only public session protocol
- live `tool.started`, `tool.progress`, and `tool.finished` are explicitly
  attempt-scoped and require `attemptId`
- authoritative tool-attempt binding comes from repo-owned tool lifecycle
  receipts plus hosted turn-attempt state
- replay remains committed-only; standalone durable `tool.finished` is still not
  projected

Read current behavior from:

- `docs/reference/gateway-control-plane-protocol.md`
- `docs/reference/runtime.md`
- `docs/reference/events.md`
- `docs/reference/session-lifecycle.md`
- `docs/research/rfc-derived-session-wire-schema-and-frontend-session-protocol.md`

## Historical Problem Statement And Scope Boundaries

At proposal time, the repository still kept live `tool.started`,
`tool.progress`, and `tool.finished` frames turn-scoped. The goal of this note
was to narrow the delta required to promote explicit attempt scoping without
reopening replay semantics or the session-wire authority boundary.

The remaining gap is now clear:

- frontend products cannot attribute live tool traffic to a specific retry or
  recovery attempt
- gateway currently hardens v1 by dropping late stale completions from
  superseded attempts so they cannot pollute the current committed turn state
- that hardening is safe for v1, but it also suppresses potentially useful live
  observability about what happened inside earlier attempts

This RFC is intentionally narrow. It covers only the public live tool-frame
contract and the internal binding source needed to make that contract stable.
It does not reopen:

- replay semantics for committed turns
- durable `turn.committed` receipts
- the `session-wire` authority boundary
- the removal of legacy `session.turn.*`

## Current State

Today the repository behaves as follows:

- replay remains committed-state only; it does not emit standalone durable
  `tool.finished`
- live tool preview frames are cache-class and turn-scoped
- gateway internally binds each `toolCallId` to the first observed attempt
  inside the turn so stale completions do not leak into the committed current
  attempt

That internal hardening was the right v1 stabilization step, but it should not
become the long-term public protocol story. The public wire should not claim
explicit attempt scoping until the repository has a stronger binding source than
the collector's current first-observation fallback.

## Decision Options

### Option A: Keep v1 Semantics Indefinitely

Summary:

- keep live tool frames turn-scoped
- continue using internal first-observation binding only as a hidden collector
  safeguard

Pros:

- no protocol churn
- no additional runtime event wiring

Cons:

- live frontend reducers remain blind to retry-attempt boundaries for tool
  traffic
- late superseded-attempt tool activity stays unobservable even when it would be
  useful to inspect
- the protocol remains weaker than the actual hosted recovery model

### Option B: Promote Current First-Observation Binding Directly Into V2

Summary:

- add `attemptId` to live `tool.*` frames
- define that `attemptId` as the first attempt observed by the gateway
  collector for a given `toolCallId`

Pros:

- cheap to implement
- directly extends the existing v1 hardening path

Cons:

- turns an implementation fallback into a public semantic guarantee
- still relies on inference rather than a repo-owned binding source
- risks overstating correctness in rare out-of-order or missing-start cases

### Option C: Recommended

Summary:

- introduce explicit attempt binding at the repo-owned tool lifecycle source
- upgrade public live `tool.*` frames in `brewva.session-wire.v2` to require
  `attemptId`
- stop dropping late superseded-attempt tool frames purely for attribution
  reasons; emit them under their bound attempt instead

Pros:

- live protocol matches the hosted retry model directly
- frontends can group tool activity by attempt without heuristics
- late tool completions from superseded attempts become inspectable instead of
  silently disappearing
- correctness improves because the wire no longer depends on hidden collector
  guesswork

Cons:

- requires coordinated runtime and gateway changes
- expands the public wire schema version
- requires clear handling for anomalous tool lifecycle events that arrive
  without a binding source

This RFC recommends Option C.

## Proposed V2 Contract

`brewva.session-wire.v2` should make live tool frames explicitly attempt-scoped:

```ts
type SessionWireFrameV2 =
  | {
      schema: "brewva.session-wire.v2";
      type: "tool.started";
      sessionId: string;
      turnId: string;
      attemptId: string;
      toolCallId: string;
      toolName: string;
      frameId: string;
      ts: number;
      source: "live";
      durability: "cache";
    }
  | {
      schema: "brewva.session-wire.v2";
      type: "tool.progress";
      sessionId: string;
      turnId: string;
      attemptId: string;
      toolCallId: string;
      toolName: string;
      verdict: "pass" | "fail" | "inconclusive";
      isError: boolean;
      text: string;
      frameId: string;
      ts: number;
      source: "live";
      durability: "cache";
    }
  | {
      schema: "brewva.session-wire.v2";
      type: "tool.finished";
      sessionId: string;
      turnId: string;
      attemptId: string;
      toolCallId: string;
      toolName: string;
      verdict: "pass" | "fail" | "inconclusive";
      isError: boolean;
      text: string;
      frameId: string;
      ts: number;
      source: "live";
      durability: "cache";
    };
```

Contract rules:

1. `attemptId` is required on all live `tool.*` frames.
2. A `toolCallId` binds to exactly one `attemptId` within a turn.
3. The wire must not guess a public `attemptId` from the current active attempt
   when no binding source exists.
4. A late tool frame may arrive after `attempt.superseded`; it still belongs to
   its original bound `attemptId`.
5. `turn.committed.toolOutputs` remains the final committed turn state and is
   not replaced by live tool preview traffic.
6. Replay remains committed-state oriented. V2 still does not introduce
   standalone durable replay `tool.finished`.

## Binding Source And Internal Design Direction

The public v2 contract should not be backed only by the current collector-side
first-observation heuristic. The repository should introduce a stronger
repo-owned binding source before promoting explicit attempt-scoped live tool
frames.

Recommended internal direction:

1. Stamp repo-owned runtime tool lifecycle receipts with attempt sequence at the
   point where the hosted turn boundary is still authoritative.
   - The most natural place is the runtime-plugin tool lifecycle bridge that
     already records `tool_execution_start` and `tool_execution_end`.
   - The preferred shape is to extend those runtime event payloads with
     `attempt: number | null`.
2. Gateway live collection should build `toolCallId -> attemptId` from those
   runtime receipts rather than from the collector's current active-attempt
   cursor.
3. When a late `tool.finished` for a superseded attempt arrives, gateway should
   emit it under the original bound `attemptId` instead of dropping it solely to
   protect current-attempt presentation.
4. If a live tool lifecycle event arrives without any authoritative binding,
   gateway should treat it as degraded input:
   - do not guess a public `attemptId`
   - drop the live preview frame
   - record a diagnostic so the missing binding can be investigated

This keeps v2 honest: the public wire becomes explicitly attempt-scoped only
after the repository has a repo-owned binding source that is stronger than the
current hidden collector fallback.

## Frontend Expectations

Frontend reducers consuming `brewva.session-wire.v2` should treat the protocol
as follows:

- `attempt.started` and `attempt.superseded` remain the attempt lifecycle spine
- live `tool.*` frames are grouped by `attemptId`, not only by `turnId`
- `turn.committed` remains the terminal accepted turn state
- late tool traffic for superseded attempts is valid live telemetry, not a
  contradiction

That model allows rich attempt-aware inspection without weakening the replay
contract.

## Source Anchors

- `packages/brewva-runtime/src/contracts/session-wire.ts`
- `packages/brewva-runtime/src/events/event-types.ts`
- `packages/brewva-gateway/src/runtime-plugins/event-stream.ts`
- `packages/brewva-gateway/src/session/collect-output.ts`
- `packages/brewva-gateway/src/session/turn-transition.ts`
- `packages/brewva-gateway/src/session/worker-main.ts`
- `test/unit/gateway/collect-output.unit.test.ts`
- `test/contract/runtime/session-wire.contract.test.ts`

## Validation Signals

Promotion should be backed by:

- contract coverage that `tool.started`, `tool.progress`, and `tool.finished`
  require `attemptId` in `brewva.session-wire.v2`
- gateway collector coverage showing late superseded-attempt tool completions
  are emitted under their original `attemptId` instead of the current one
- runtime plugin coverage showing the repo-owned tool lifecycle bridge stamps
  attempt binding on normal tool execution paths
- degraded-path coverage showing gateway drops unbound live tool preview frames
  rather than inventing a guessed `attemptId`
- docs alignment between gateway protocol, runtime events, and session
  lifecycle references

## Promotion Criteria

This RFC can be promoted once:

1. repo-owned tool lifecycle receipts expose stable attempt binding
2. `brewva.session-wire.v2` is the only public session protocol in code and docs
3. live tool frames are explicitly attempt-scoped in contract tests
4. superseded-attempt late tool frames are covered by regression tests
5. stable docs fully replace this note with the accepted v2 contract
