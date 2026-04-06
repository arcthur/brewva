# Reference: Session Lifecycle

## Lifecycle Stages

1. Parse CLI args and resolve mode/input (`packages/brewva-cli/src/index.ts`)
2. Create session + runtime (`packages/brewva-gateway/src/host/create-hosted-session.ts`)
   - runtime config is loaded/normalized first
   - startup UI setting (`ui.quietStartup`) is applied from `runtime.config.ui` into session settings overrides
3. Register lifecycle handlers through the canonical hosted pipeline (`packages/brewva-gateway/src/runtime-plugins/index.ts`)
   - `managedToolMode=runtime_plugin`: register managed Brewva tools through the runtime plugin API
   - `managedToolMode=direct`: provide managed Brewva tools directly from the host
4. Run turn loop with tool execution, ledger/event writes, and verification updates
5. Materialize durable turn receipts (`turn_input_recorded`,
   `turn_render_committed`), expose derived session wire replay through the
   runtime-owned session-wire compiler surface, and dispose session resources

## Mode-Specific Paths

- Replay (`--replay`): query structured events and print text/JSON timeline
- Undo (`--undo`): resolve target session and rollback the latest tracked `PatchSet`
- JSON one-shot (`--mode json`/`--json`): emits normal stream plus final `brewva_event_bundle`
- `--managed-tools direct`: keeps the same hosted lifecycle shape, but managed
  Brewva tools are provided directly by the host instead of being registered by
  the runtime plugin package
- Channel gateway (`--channel`): run adapter bridge loop; bind conversations to scopes, then scopes to agent sessions, and dispatch inbound turns serially per scope

## Durability Boundaries

Session lifecycle behavior is anchored to the repository durability taxonomy:

- `durable source of truth`
  - event tape, checkpoints, proposal receipts, approval events, task/truth
    events, and schedule intent events
- `durable transient`
  - Recovery WAL and rollback patch/snapshot history used for bounded recovery or
    undo
- `rebuildable state`
  - working projection files and workflow posture derived from replayable
    events
- `cache`
  - channel UI helper state, gateway `session.status`, and other routing hints
    outside the replay contract

Deletion consequences:

- removing projection files must not change replay correctness
- removing channel helper state must not break approval truth or exact resume
- removing Recovery WAL can affect in-flight recovery, but not historical truth

## Recovery Path

- On `SIGINT`/`SIGTERM`, CLI records `session_turn_transition` with
  `reason=signal_interrupt`, waits for agent idle (bounded by graceful
  timeout), then exits.
- Next startup reconstructs foldable replay state from event tape (`checkpoint + delta` replay),
  including task/truth/cost/evidence/projection fold slices.
- First `onTurnStart()` hydrates session-local runtime state from tape events
  (skill/budget/cost counters, warning dedupe, ledger compaction cooldown).
- Gateway and frontend session replay do not consume raw `inspect.events`.
  Runtime-scoped replay uses `runtime.inspect.sessionWire`; gateway public
  replay uses the same runtime-owned compiler semantics against archived
  agent-session event logs. In both cases replay is compiled from durable
  receipts including `turn_input_recorded`, `turn_render_committed`, approval
  events, delegation receipts, transition receipts, and `session_shutdown`.
- Live gateway preview traffic remains cache-class and transport-owned. In the
  current wire, live tool frames are explicitly attempt-scoped through
  authoritative tool lifecycle binding, while replay remains committed-state
  only.
- Gateway public-session lookup is also durable: the gateway records
  `gateway_session_bound` receipts on a control tape so archived replay does
  not depend on process-local binding memory.
- malformed or unreadable event tape rows degrade hydration status and surface
  explicit `event_tape` integrity issues instead of being treated as an empty
  healthy tape.
- Note: upstream `turnIndex` can reset to `0` on `agent_start` boundaries. Brewva normalizes turns to be monotonic per session (for example `effectiveTurn = max(current, turnIndex)`) and uses the normalized value for gating/reconciliation.
- If projection artifacts are missing, runtime can rebuild projection files from
  source tape events using deterministic projection extraction rules.
  `projection_ingested` and `projection_refreshed` remain projection telemetry,
  not semantic rebuild inputs.
- Channel approval helper state is not part of recovery correctness.
  Approval truth and request resolution remain replay-derived from durable
  runtime events, with optional process-local UI cache only.
- Telegram polling restart offset is derived from durably accepted channel
  Recovery WAL ingress watermark state (`meta.ingressSequence`, projected from
  Telegram `update_id`), not from process-local transport memory.
- “durably accepted” here means ingress acceptance, not successful execution:
  `pending`, `inflight`, `done`, `failed`, and `expired` rows can all advance
  the Telegram polling watermark, because retry responsibility stays local to
  Recovery WAL recovery instead of upstream redelivery.
- Channel outbound delivery is not replay-critical durable state. Telegram send
  requests perform bounded per-request retry only on explicit retryable provider
  rejections, then surface `channel_turn_outbound_error` once retry budget is
  exhausted.
- Recovery WAL remains bounded recovery state rather than historical truth, but WAL
  integrity failures now fail closed for recovery until the corrupted rows are
  repaired; Recovery WAL compaction preserves the latest ingress watermark through a
  metadata-only marker needed for polling recovery.
- `runtime.inspect.session.getIntegrity(sessionId)` is the canonical operator-facing
  health read model. It aggregates `event_tape`, `recovery_wal`, and `artifact`
  durability issues into one status surface.
