# Reference: Gateway Control Plane Protocol

Implementation entry point: `packages/brewva-gateway/src/protocol/schema.ts`.

## Transport and Addressing

- Transport: WebSocket.
- Address shape: `ws://<loopback-host>:<port>`.
- Security rule: server accepts loopback hosts only (see `packages/brewva-gateway/src/network.ts`).

## Frame Model

The protocol uses three frame types:

- `req`: request frame (`id`, `method`, `params`, optional `traceId`).
- `res`: response frame (`id`, `ok`, `payload`/`error`, optional `traceId`).
- `event`: event frame (`event`, optional `payload`, optional `seq`).

Error payload structure:

- `code`: `invalid_request`, `unauthorized`, `bad_state`, `method_not_found`, `internal_error`, `timeout`.
- `message`: human-readable error message.
- `retryable`: optional retry hint.
- `details`: optional machine-readable metadata.

## Handshake Flow

1. Client opens WebSocket connection.
2. Server emits `connect.challenge` with `nonce`.
3. Client sends `connect`:
   - `protocol` must exactly match server protocol version.
   - `challengeNonce` must match the nonce from step 2.
   - `auth.token` must match the current gateway token.
4. On success, server returns `hello-ok` with methods, events, and policy limits (for example `maxPayloadBytes`).

Client implementation: `packages/brewva-gateway/src/client.ts`.  
Server implementation: `packages/brewva-gateway/src/daemon/gateway-daemon.ts`.

## Methods (`GatewayMethods`)

- `connect`
- `health`
- `status.deep`
- `scheduler.pause`
- `scheduler.resume`
- `sessions.open`
- `sessions.subscribe`
- `sessions.unsubscribe`
- `sessions.send`
- `sessions.abort`
- `sessions.close`
- `heartbeat.reload`
- `gateway.rotate-token`
- `gateway.stop`

Parameter summary (current semantics):

- `connect`: `{ protocol, client, auth: { token }, challengeNonce }`
- `health`: `{}`
- `status.deep`: `{}`
- `scheduler.pause`: `{ reason? }`
- `scheduler.resume`: `{}`
- `sessions.open`: `{ sessionId?, cwd?, configPath?, model?, agentId?, managedToolMode? }`
- `sessions.subscribe`: `{ sessionId }`
- `sessions.unsubscribe`: `{ sessionId }`
- `sessions.send`: `{ sessionId, prompt, turnId? }`
- `sessions.abort`: `{ sessionId, reason? }`
- `sessions.close`: `{ sessionId }`
- `heartbeat.reload`: `{}`
- `gateway.rotate-token`: `{}`
- `gateway.stop`: `{ reason? }`

## Heartbeat Policy Surface

`HEARTBEAT.md` rules are control-plane policy, not gateway RPC methods.

Current JSON-block rule shape:

- `id`
- `intervalMinutes`
- `prompt`
- `sessionId?`

Rule semantics:

- `prompt` is the model-facing wake-up instruction.
- heartbeat rules are always explicit fires now; there is no cognition-driven
  wake suppression layer.

## Response Semantics (Key Methods)

- `connect`: `hello-ok` payload with `protocol`, `server`, `features`, and `policy`.
- `sessions.send`: immediate ack payload `{ sessionId, agentSessionId?, turnId, accepted: true }`; final turn outcome arrives through `session.wire.frame`.
- `sessions.abort`: accepts optional `reason: "user_submit"` so hosted execution can emit `user_submit_interrupt` as a `session_turn_transition` without widening kernel authority.
- `status.deep`: includes `heartbeat` plus live `scheduler` execution state. The `scheduler` block exposes whether scheduling is available, whether execution is paused, and current projection/timer counters.
- `scheduler.pause`: `{ paused: true, changed, available, pausedAt, reason }`.
- `scheduler.resume`: `{ paused: false, changed, available, previousPausedAt, previousReason }`.
- `gateway.rotate-token`: `{ rotated: true, rotatedAt, revokedConnections }`.
- `gateway.stop`: `{ stopping: true, reason }`.

## Events (`GatewayEvents`)

- `connect.challenge`
- `tick`
- `session.wire.frame`
- `heartbeat.fired`
- `shutdown`

Session-scoped events (`session.wire.frame`) are routed by subscription scope,
not broadcast to every authenticated connection.

## Session Wire Stream

The public session stream is a single event family carrying
`brewva.session-wire.v2` frames.

`sessions.subscribe` has replay-first semantics:

1. `replay.begin`
2. durable replay frames compiled through the runtime-owned session-wire
   compiler from the archived agent-session tape segments bound to the public
   session
3. `replay.complete`
4. replay-window buffered live traffic is flushed
5. if no newer live status is already buffered or in flight, gateway emits a
   gateway-owned `session.status` snapshot

Gateway public-session replay lookup is durable and restart-safe. It resolves
public `sessionId -> agent session tape segment` through the gateway control
tape (`gateway_session_bound` receipts), not through worker-local memory or a
JSON binding registry.

Gateway does not need a live runtime instance to replay archived public
sessions. Runtime instances expose `inspect.sessionWire` for runtime-scoped
session ids; gateway uses the same runtime-owned compiler semantics after it
locates the underlying archived agent-session tapes.

Gateway does not treat an old terminal `session.status` cache as authority.
Reopening the same public `sessionId` resets the live status lifecycle; later
subscribe snapshots are derived fresh from replay plus current worker state.

Important protocol rules:

- `turn.committed` is the only terminal turn frame.
- replay does not emit standalone durable `tool.finished`; final tool outputs
  are carried by `turn.committed.toolOutputs`.
- live tool frames are attempt-scoped cache frames: `tool.started`,
  `tool.progress`, and `tool.finished` all carry `attemptId`.
- live tool `attemptId` is not guessed from the current active attempt at
  emission time. Gateway binds each `toolCallId` to an authoritative attempt
  from repo-owned tool lifecycle receipts (`tool_call`, `tool_execution_start`,
  `tool_execution_end`) and hosted turn-attempt state.
- late superseded-attempt tool completions still emit live `tool.finished`
  under their original bound `attemptId`; they are not silently rewritten to
  the current attempt.
- live `tool.finished` is a preview/update frame. `turn.committed.toolOutputs`
  is the committed final tool state for the turn and supersedes earlier live
  previews.
- `turn.committed.toolOutputs` includes only accepted final-attempt tool state.
  Late superseded-attempt live tool frames remain telemetry and do not re-enter
  committed replay state.
- only live cache emits `assistant.delta`, `attempt.started(reason=initial)`,
  and `session.status`.
- durable session-wire frames carry `sourceEventId` and `sourceEventType`;
  cache frames and replay control frames do not.
- `session.status.contextPressure` is a live cache projection derived from
  runtime context inspect data.
- replay and live are semantically aligned but not frame-isomorphic; replay does
  not promise frame-for-frame reproduction of live preview traffic.

## Latest-Only Compatibility Policy

The current protocol intentionally does not keep legacy compatibility branches:

- `connect` does not accept protocol ranges; single-value `protocol` only.
- `sessions.send` is stream-first only; response is acknowledgment (`accepted`, `turnId`), with output streamed through `session.wire.frame`.
- `gateway.rotate-token` does not accept `graceMs`; rotation takes effect immediately.

## CLI JSON Output Contracts (Automation)

`brewva gateway` subcommands emit stable `schema` fields:

- `brewva.gateway.lifecycle.v1`
- `brewva.gateway.status.v1`
- `brewva.gateway.stop.v1`
- `brewva.gateway.scheduler-pause.v1`
- `brewva.gateway.scheduler-resume.v1`
- `brewva.gateway.heartbeat-reload.v1`
- `brewva.gateway.rotate-token.v1`
- `brewva.gateway.logs.v1`
- `brewva.gateway.install.v1`
- `brewva.gateway.uninstall.v1`

Optional HTTP probe endpoint (`--health-http-port`, default path `/healthz`) responds with:

- `brewva.gateway.health-http.v1`

Implementation: `packages/brewva-gateway/src/cli.ts`.
