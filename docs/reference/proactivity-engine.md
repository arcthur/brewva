# Reference: Proactivity

Proactivity is an explicit, operator-authored control-plane heartbeat path. The
runtime does not infer when to wake from cognition signals; operators author the
trigger and the model receives it.

## Current Trigger Path

Current heartbeat behavior is intentionally direct:

1. `HeartbeatScheduler` fires a rule from the configured `HEARTBEAT.md` policy
   file (default `<global brewva root>/agent/gateway/HEARTBEAT.md`).
2. Gateway resolves the target session and opens it if needed.
3. Gateway sends the rule's explicit `prompt`.
4. The worker processes that prompt like any other turn.

There is no separate wake plan, skip plan, or replayable wake metadata event.
The live control plane may emit `heartbeat.fired`, but that event is not
durable event-tape authority and it is not replayed as runtime wake metadata.

## Heartbeat Rule Shape

Current file shape is a fenced `heartbeat` JSON/JSONC block whose payload
contains one `rules` array. Each rule object supports:

- `id?`
- `intervalMinutes`
- `prompt`
- `sessionId?`

Semantics:

- `prompt` is the primary model-facing instruction.
- when `id` is omitted, gateway assigns the deterministic fallback
  `rule-<index>` during policy load
- when `sessionId` is omitted, gateway uses the deterministic default
  `heartbeat:<id>`
- the file path itself is control-plane configuration; `brewva gateway
--state-dir` / `--heartbeat` may relocate it without changing rule semantics

## Boundary Rules

Heartbeat remains a control-plane scheduling primitive:

- it may open a session and deliver an explicit prompt
- it may not infer whether intelligence should wake based on cognition signals
- it may not inject hidden context or memory directly

This keeps wake-up behavior legible: operators author the trigger, the model
receives the trigger, and the runtime stays out of the planning business.
