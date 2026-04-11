# Reference: Proactivity (Removed)

The repository no longer ships a cognition-driven `ProactivityEngine`.

What remains is an explicit control-plane heartbeat path.

## Current Trigger Path

Current heartbeat behavior is intentionally direct:

1. `HeartbeatScheduler` fires a rule from the configured `HEARTBEAT.md` policy
   file (default `<global brewva root>/agent/gateway/HEARTBEAT.md`).
2. Gateway resolves the target session and opens it if needed.
3. Gateway sends the rule's explicit `prompt`.
4. The worker processes that prompt like any other turn.

There is no separate wake plan, skip plan, or replayable wake metadata event.
The live control plane may emit `heartbeat.fired`, but that event is not
durable tape truth and it is not replayed as runtime wake metadata.

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

## Removed Semantics

The following concepts are gone from the default product path:

- wake-vs-skip planning
- cognition-driven wake suppression
- `wakeMode`
- `staleAfterMinutes`
- `heartbeat.skipped`
- `proactivity_wakeup_prepared`
- wake-context assembly from summary signals
- heartbeat-specific `objective` / `contextHints` side fields

## Boundary Rules

Heartbeat remains a control-plane scheduling primitive:

- it may open a session and deliver an explicit prompt
- it may not infer whether intelligence should wake based on cognition signals
- it may not inject hidden context or memory directly

This keeps wake-up behavior legible: operators author the trigger, the model
receives the trigger, and the runtime stays out of the planning business.
