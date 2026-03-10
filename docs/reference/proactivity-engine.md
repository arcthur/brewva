# Reference: Proactivity Engine

Current implementation surfaces:

- `packages/brewva-gateway/src/daemon/heartbeat-policy.ts`
- `packages/brewva-gateway/src/daemon/gateway-daemon.ts`
- `packages/brewva-gateway/src/daemon/session-supervisor.ts`
- `packages/brewva-gateway/src/session/worker-main.ts`
- `packages/brewva-extensions/src/proactivity-context.ts`

## Role

`ProactivityEngine` is the control-plane bridge between wake-up triggers and
model-facing cognition.

It does not decide commitments. It records wake-up intent and context hints so
the cognitive plane can rehydrate better memory before the model starts
working.

## Current Trigger Path

Current heartbeat path:

1. `HeartbeatScheduler` fires a rule from `HEARTBEAT.md`.
2. Gateway resolves the target session and sends the prompt through the session
   worker.
3. The worker records `proactivity_wakeup_prepared` with trigger metadata such
   as rule id, objective, and context hints.
4. `MemoryCurator` reads the latest wake-up metadata on `before_agent_start`
   and expands its retrieval query before proposing `context_packet` hydration.
5. The model starts with the accepted context, not just the raw heartbeat
   prompt.

## Heartbeat Rule Extensions

Heartbeat rules may optionally declare:

- `objective`
  - a durable description of why the wake-up exists
- `contextHints`
  - additional retrieval hints for the memory curator

These fields are control-plane metadata. They do not bypass the proposal
boundary or create kernel truth.

## Boundary Rules

`ProactivityEngine` may:

- decide when to wake a session
- attach wake-up metadata and retrieval hints
- influence future cognition selection through replayable trigger events

`ProactivityEngine` may not:

- mutate kernel state directly
- inject context without proposal receipts
- override runtime policy or compaction gates
