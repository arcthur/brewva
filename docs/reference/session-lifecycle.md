# Reference: Session Lifecycle

This page describes hosted-session ordering, durability, and recovery
boundaries. Runtime-plugin factory options, port ownership, and command-plugin
composition live in `docs/reference/runtime-plugins.md`.

## Lifecycle Stages

1. Parse CLI args and resolve mode/input (`packages/brewva-cli/src/index.ts`)
2. Create session + runtime through the stable host entrypoint
   (`packages/brewva-gateway/src/host/create-hosted-session.ts`; implementation
   lives in `packages/brewva-gateway/src/host/hosted-session-bootstrap.ts`)
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
- `brewva inspect`: builds an operator forensic report for one replayable
  session from tape plus nearby artifact diagnostics; it is not the live
  transport replay stream
- `--managed-tools direct`: keeps the same hosted lifecycle shape, but managed
  Brewva tools are provided directly by the host instead of being registered by
  the runtime plugin package; wiring details live in
  `docs/reference/runtime-plugins.md`
- Channel gateway (`--channel`): run adapter bridge loop; bind conversations to scopes, then scopes to agent sessions, and dispatch inbound turns serially per scope

## Durability Boundaries

Session lifecycle behavior is anchored to the repository durability taxonomy:

- `durable source of truth`
  - event tape, checkpoints, reasoning-branch receipts, proposal receipts,
    approval events, task/truth events, and schedule intent events
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
- removing `session_compact` receipts does change replay correctness because the
  history-view baseline is authority-bearing even though its inspect/context
  view is rebuilt on demand
- removing channel helper state must not break approval truth or exact resume
- removing Recovery WAL can affect in-flight recovery, but not historical truth

## Recovery Path

Target recovery order is:

1. canonicalize and diagnose recovery posture
2. hydrate replay-owned runtime state from tape
3. rebuild the history-view baseline
4. derive the recovery working set
5. admit context through the normal provider path

Step 3 is not a projection-cache rebuild. The history-view baseline is the
receipt-derived rewrite authority rebuilt from durable `session_compact`
history, while working projection remains a separate rebuildable snapshot.

Current implementation now performs the first recovery canonicalization pass
before hydration from tape alone. If the tape already contains a durable
`unclean_shutdown_reconciled` receipt, that receipt is reused directly; if not,
the canonicalization pass still detects replay-visible open tool, open turn,
and dangling active-skill conditions from the tape before any fold state is
rebuilt. Hydration apply may still materialize a new
`unclean_shutdown_reconciled` receipt afterward when an older session needs a
durable reconciliation record.

Recovery posture remains tape-derived after hydration as well. The runtime keeps
the `unclean_shutdown_reconciled` receipt for explainability and operator
inspection, but later recovery transition receipts supersede that degraded
posture instead of letting a process-local diagnostic pin the session in
permanent degradation.

- On `SIGINT`/`SIGTERM`, CLI records `session_turn_transition` with
  `reason=signal_interrupt`, waits for agent idle (bounded by graceful
  timeout), then exits.
- Next startup reconstructs replay-owned hydration state from event tape
  (`checkpoint + delta` replay), including skill, tool-lifecycle,
  verification, resource-lease, cost, evidence-ledger, reversible-mutation,
  and parallel-budget state.
- Projection rebuild remains a separate on-demand projection-engine path. It is
  not part of `SessionLifecycleService` hydration and it does not gate replay
  correctness.
- Reasoning-branch truth is reconstructed from durable `reasoning_checkpoint`
  and `reasoning_revert` receipts. Recovery WAL does not hold the active
  branch; it only carries the in-flight turn envelope.
- Session-local runtime state is hydrated lazily through `ensureHydrated(...)`.
  The first hydration may happen on `onUserInput()`, `onTurnStart()`, or a
  later inspect/read-model access that needs replay-owned state
  (skill/budget/cost counters, warning dedupe, ledger compaction cooldown).
- `onTurnStart()` remains the first canonical turn-boundary hook that both
  hydrates and advances per-turn runtime state such as context-budget turn
  bookkeeping.
- durable session teardown is separate from replay truth: on hosted
  `session_shutdown`, runtime records or reconciles the terminal receipt first,
  then clears session-local hydrated state, caches, turn clocks, and other
  rebuildable helpers through `maintain.session.clearState(sessionId)`. Later
  inspection or replay rehydrates from tape again instead of depending on
  process-local leftovers.
- Recovery posture is derived from two bounded read models:
  - the history-view baseline, which is authority-anchored and scoped by the
    current reference-context digest
  - the recovery working set, which carries operational continuation state such
    as pending recovery family, open tool calls, and resume contract hints
- Gateway and frontend session replay do not consume raw `inspect.events`.
  Runtime-scoped replay uses `runtime.inspect.sessionWire`; gateway public
  replay uses the same runtime-owned compiler semantics against archived
  agent-session event logs. In both cases replay is compiled from durable
  receipts including `turn_input_recorded`, `turn_render_committed`, approval
  events, delegation receipts, transition receipts, and `session_shutdown`.
- `brewva inspect` is adjacent to that replay pipeline but not identical to it:
  the command builds an operator report from `inspect.events`,
  `inspect.session`, `inspect.recovery`, and nearby artifact checks instead of
  subscribing to `inspect.sessionWire`.
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
- That projection rebuild does not recreate history authority on its own. The
  history-view baseline still comes from durable `session_compact` receipts plus
  reference-context compatibility checks. If no compatible compaction baseline
  exists, `inspect.context.getHistoryViewBaseline(...)` can still expose a
  bounded `exact_history` continuity snapshot derived from
  `turn_input_recorded` / `turn_render_committed`, but that fallback is not a
  replacement for receipt-backed history rewrite authority.
- Before a recovered prompt runs, hosted recovery checks whether the latest
  durable reasoning revert has already completed `reasoning_revert_resume`.
  If not, the worker rebuilds the active branch from the revert target,
  replaces model-visible messages from that surviving branch, and resumes with
  bounded hosted continuity instead of replaying superseded history.
- `completed` is the only terminal hosted-resume status for replay purposes.
  Any latest reasoning revert without a completed
  `reasoning_revert_resume` receipt remains pending for the next serialized
  recovery pass.
- That reasoning resume remains owned by the serialized turn runner that was
  already handling the prompt. Hosted recovery prepares the branch reset, but it
  does not start a second out-of-band prompt behind the scheduler.
- `reasoning_revert_resume` is therefore crash-safe over the existing gateway
  prompt WAL: the WAL replays the pending turn envelope, while tape determines
  whether branch reset must be re-applied first.
- Channel approval helper state is not part of recovery correctness.
  Approval truth and request resolution remain replay-derived from durable
  runtime events, with optional process-local UI cache only.
- Telegram polling restart offset is derived from durably accepted channel
  Recovery WAL ingress watermark state (`meta.ingressSequence`, projected from
  Telegram `update_id`), not from process-local transport memory.
- That polling watermark identity is separate from ingress and WAL dedupe keys:
  edge Worker dedupe uses `update_id`, Fly ingress prefers projected
  message/callback identity with `update_id` fallback, and channel Recovery
  WAL recoverable dedupe uses `${turn.channel}:${turn.turnId}`.
- “durably accepted” here means ingress acceptance, not successful execution:
  `pending`, `inflight`, `done`, `failed`, and `expired` rows can all advance
  the Telegram polling watermark, because retry responsibility stays local to
  Recovery WAL recovery instead of upstream redelivery.
- `channel_turn_ingested` is earlier bridge telemetry emitted when the adapter
  hands a turn to the host before dispatcher-owned `appendPending(...)` writes
  the Recovery WAL row, so it must not be read as durable ingress acceptance.
- `channel_turn_emitted` is successful bridge send telemetry for the prepared
  outbound turn, not replay-critical delivery truth.
- `channel_turn_bridge_error` currently records failures from that outbound
  bridge `sendTurn(...)` path; it is narrower than generic inbound processing
  failure telemetry.
- Channel outbound delivery is not replay-critical durable state. Telegram send
  requests may perform bounded transport-local retry for retryable send
  failures such as `429` or `5xx`, but `channel_turn_outbound_error` records
  any outbound turn whose `sendTurn(...)` still throws after that transport
  handling, including immediate non-retryable failures.
- Recovery WAL remains bounded recovery state rather than historical truth, but WAL
  integrity failures now fail closed for recovery until the corrupted rows are
  repaired; Recovery WAL compaction preserves the latest ingress watermark through a
  metadata-only marker needed for polling recovery.
- `runtime.inspect.session.getIntegrity(sessionId)` is the canonical operator-facing
  health read model. It aggregates `event_tape`, `recovery_wal`, and `artifact`
  durability issues into one status surface.
