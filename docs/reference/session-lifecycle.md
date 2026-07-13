# Reference: Session Lifecycle

This page describes hosted-session ordering, durability, and recovery
boundaries. Extension factory options, port ownership, and command-plugin
composition live in `docs/reference/extensions.md`.

Hosted and CLI entrypoints converge on the same repo-owned substrate route:
`createHostedSession(...)` and `createBrewvaSession(...)` bootstrap the same
managed session lifecycle. `Pi runtime` is not on the execution-critical path;
`Pi` compatibility is limited to import/export artifacts and reference
comparison.

## Runtime-Owned Lifecycle Contract

`HostedRuntimeAdapterPort.ops.lifecycle.getSnapshot(sessionId)` is the hosted-adapter
session-posture read model.

It exists to answer a runtime-wide question that domain reducers do not answer
by themselves: "what state is this session in right now?" The runtime keeps the
underlying domain reducers independent, then composes them into one aggregate
lifecycle snapshot.

The hosted-adapter contract is exported as `SessionLifecycleSnapshot` (keyed by
`sessionId`) and is shaped around orthogonal axes rather than one flat phase enum:

- `hydration` (the four-port snapshot currently returns a stub literal here; the
  rich `ready` / `cold` / `degraded` value lives in the separate hydration
  projection)
- `execution`
- `recovery`
- `approval`
- `tooling`
- `integrity` (a snapshot-field stub literal, distinct from the fully projected
  `getIntegrity(...)` operator read under Recovery Path)
- `summary`

This snapshot is:

- runtime-owned
- replay-derived
- read-only
- not a second truth source

Durable authority remains on tape, receipts, and Recovery WAL. The lifecycle
snapshot is the unique runtime interpretation of that authority plus approved
rebuildable helpers such as hydration state, approval state, open tool calls,
recovery posture, canonical runtime causes, and session-wire facts.

## Summary Precedence

The aggregate summary surface exists so adapters do not keep inventing their own
cross-axis posture logic. `summary.kind` is a runtime-owned answer to "what
posture should adapters present right now?", while the per-axis fields carry the
precision needed for specialized products.

The four-port snapshot emits a minimal `summary.kind` of `running` or `idle`,
derived from turn-state activity. Richer posture is read from the surface that
owns it — `cold` / `degraded` from the hydration and integrity projections, and
`recovering` / `closed` from the host-local `SessionPhase` controller — not from
`SessionLifecycleSnapshot.summary`.

## Adapter And Controller Rule

Gateway and host products are consumers of the lifecycle contract, not parallel
authorities.

In particular:

- gateway `session.status` is an adapter over runtime lifecycle plus
  transport-local cache concerns
- provider-request recovery heuristics and similar policy adapters should read
  lifecycle posture instead of rescanning raw event history
- host `SessionPhase` is a local controller FSM for interaction flow and UI
  state; it does not define the authoritative meaning of durable session
  lifecycle

## Queued Prompt Contract

Queued prompts remain a hosted-loop concern with four stable rules:

1. Interactive composer submissions made during active streaming default to
   queued delivery when the caller omits `streamingBehavior`. Explicit
   `followUp` producers remain explicit and do not silently widen into queued
   future turns.
2. Queued prompt inspection is prompt-id based. Managed sessions project queued
   items as `BrewvaQueuedPromptView` records carrying `promptId`, text,
   `submittedAt`, and `behavior`.
3. Queued prompt removal is id-based and race-safe. `removeQueuedPrompt(id)`
   removes the still-pending entry when it exists and returns `false` when the
   prompt is already consumed or missing; that outcome is advisory, not an
   exceptional lifecycle error.
4. Queue and `followUp` remain separate lanes. Queue entries release before
   follow-ups regardless of arrival order. Each lane independently uses its
   configured `one-at-a-time` or `all` release mode; an `all` batch drains only
   that lane before the other lane becomes eligible.

The CLI's pending strip and queue overlay intentionally surface only
`behavior="queue"` entries. Explicit `followUp` delivery remains a distinct
continuation lane even though both travel through the hosted loop's between-turn
pending-message machinery.

The stable rule is that `runtime.turn` owns aggregate posture semantics and
gateway adapters only project transport/session views from canonical tape.

## Runtime Turn Projection

The runtime turn projection is the tape-derived ordering model for one accepted
turn. It is not a process-local status surface and it is not a replacement for
the session lifecycle aggregate.

One turn projection covers the path from accepted ingress to terminal receipt.
Multiple model-to-tool iterations inside that accepted turn stay inside the same
runtime turn; each tool call still has its own single-tool-call Kernel
transaction.

| Concept                            | Granularity               | Durability                     | Primary reader                               |
| ---------------------------------- | ------------------------- | ------------------------------ | -------------------------------------------- |
| runtime turn projection            | per runtime turn          | canonical tape projection      | runtime and gateway adapters                 |
| `SessionLifecycleSnapshot.summary` | per session               | rebuildable runtime projection | host and gateway adapters                    |
| host `SessionPhase`                | per UI/controller session | process-local controller state | host UI and interaction controls             |
| canonical recovery cause           | per runtime turn          | canonical tape projection      | runtime turn implementation and replay tools |

The turn's durable progression is the canonical event tape. One accepted turn
appends `turn.started`, then model and tool events (`reason.committed` /
`msg.committed`, and per tool call `tool.proposed`, `tool.started`, then
`tool.committed` or `tool.aborted`), and either terminates with `turn.ended` or
suspends with `runtime.suspended`. The `turn_state` tape projection folds the
canonical bookends into `{ active, lastCause, lastEvent }`.

Progression is monotonic and append-only (invariant 11, turn lifecycle
monotonicity): a turn never rewrites prior event tape, and recovery supersession
advances forward without rewinding. The `superseded` marker means the turn passed
through a trusted recovery supersession at least once, not that the current
terminal posture is still in recovery.

Hydration and posture projections derive from the canonical event tape.
`createHostedProjections` exposes tape-scan projections — hydration
status (`ready` / `cold` / `degraded`), integrity status, resource leases,
workbench, worker results, and task spec/items/blockers/requirements — and
`runtime.ops.session.taskWatchdog` owns task-stall adjudication. Each reads
canonical events.

Recovery placement is declared by the runtime cause vocabulary and carried by
canonical events. `RUNTIME_RECOVERY_CAUSES` is exactly these five causes:

| Recovery cause        | Carrier canonical event                                             |
| --------------------- | ------------------------------------------------------------------- |
| `approval_pending`    | `runtime.suspended`, with `approval.requested` / `approval.decided` |
| `compaction_required` | `runtime.suspended` (envelope resume keys on compaction)            |
| `provider_retry`      | `runtime.suspended` (zero-frame retry)                              |
| `interrupt`           | `runtime.suspended`                                                 |
| `terminal_commit`     | `turn.ended`                                                        |

`checkpoint.committed` also carries a cause, and the `recovery_history` projection
folds these canonical events into the session's recovery posture. Replay and
operator explanation read the canonical events and tape projections directly.

## Lifecycle Stages

1. Parse CLI args, resolve mode/input, and apply terminal capability policy
   (`packages/brewva-cli/src/index.ts`)
   - prompt resolution happens before interactive fallback decisions
   - the OpenTUI runtime is loaded only after the CLI commits to interactive
     split-footer execution
   - non-TTY and other low-capability terminals may fall back to one-shot text
     mode when the interactive shell is not viable
2. Create session + runtime through the stable host entrypoint
   (`packages/brewva-gateway/src/hosted/api.ts`; implementation lives in
   `packages/brewva-gateway/src/hosted/internal/session/init/session-assembly.ts`)
   - runtime config is loaded/normalized first
   - startup UI setting (`ui.quietStartup`) is applied from `runtime.config.ui` into session settings overrides
   - CLI and hosted routes share the same session bootstrap, then enter the
     runtime-owned turn loop through the hosted adapter
   - non-hosted direct consumers must construct `BrewvaRuntime` directly; there
     is no second public turn owner
3. Register lifecycle handlers through the canonical hosted behavior (`packages/brewva-gateway/src/hosted/internal/session/host-api-installation.ts`)
   - `managedToolMode=hosted`: register managed Brewva tools through the hosted behavior API
   - `managedToolMode=direct`: provide managed Brewva tools directly from the host
4. Enter the canonical hosted turn envelope
   (`packages/brewva-gateway/src/hosted/internal/turn/turn-envelope.ts`)
   - entrypoints construct a session and semantic turn request; they do not
     reimplement profile resolution, turn-id/runtime-turn binding,
     schedule-trigger prelude, WAL resume transitions, or terminal render
     receipts
   - every production accepted hosted prompt turn records
     `turn.input.recorded`
   - `turn.render.committed` is recorded only for terminal
     `completed | failed | cancelled` outcomes; approval `suspended` turns
     remain represented by the input receipt plus approval/session-wire frames
   - envelope diagnostics stay process-local; replay and operator diagnostics use
     turn receipts, approval receipts, schedule warning receipts, and canonical
     runtime projections rather than a separate durable diagnostics event
5. The envelope delegates the prompt to the runtime-owned turn loop
   - `interactive` and `print` keep schedule trigger and Recovery WAL replay out
     of the ordinary human fast path
   - `scheduled`, `heartbeat`, `wal_recovery`, `channel`, and `subagent`
     profiles opt into the control-plane features their entrypoint needs
   - `runtime.turn(...)` owns model materialization, provider streaming, tool
     transaction frames, context pressure, retry discipline, and terminal
     canonical tape commits
   - gateway adapters forward runtime frames into session-wire preview frames;
     they do not maintain turn truth or recovery policy
   - `@brewva/brewva-substrate/compaction` owns pure compaction helpers for
     summary projection, token estimation, and cut-point selection
   - profile selection, terminal render receipts, and transport diagnostics
     remain gateway-owned adapter behavior
6. Expose derived session wire replay through the runtime-owned session-wire
   compiler surface and dispose session resources

## Mode-Specific Paths

- Replay (`--replay`): query structured events and print raw text/JSON records
- Replay timeline (`--replay-timeline`): query structured events and print a
  redacted timeline projection
- Undo (`--undo`): resolve target session and rewind the latest active session
  checkpoint, including reasoning state and patch receipts
- Rewind (`/rewind`): target an active-lineage checkpoint from the interactive
  shell and choose `conversation`, `code`, or `both` semantics
- Redo (`--redo`): reapply the latest undone session rewind window
- JSON one-shot (`--mode json`/`--json`): emits normal stream plus final `brewva_event_bundle`
- Interactive CLI: uses the same managed session substrate as hosted execution;
  product differences stay in operator UX and transport, not in runtime
  authority state
  - once mode resolution commits to interactive execution, CLI boots the
    OpenTUI-backed shell in `split-footer` (transcript committed to native
    scrollback, only the footer stays live)
  - ordinary non-streaming prompts run through the `interactive` hosted-loop
    profile; streaming queue and `followUp` inputs enter separate between-turn
    continuation lanes
  - approvals, questions, task browser summaries, subagent footer detail,
    inspect, lineage checkout, session switching, and pager drill-down remain
    presentation over Brewva-owned session state
    rather than a second lifecycle authority
  - `/tree` opens a context-entry micro tree over the existing event tape and
    lineage context-entry records; checkout is conversation-only unless the
    operator explicitly escalates to rewind
  - tree prompt restoration restores literal user text only. File mentions and
    slash text are re-resolved on submit against the current workspace; image,
    blob, and other non-lossless payloads are not restored automatically.
  - branch carry from `/tree` records an ordinary branch-summary event with a
    stable details schema. Checkout that leaves the current branch tail offers
    no summary, generated summary, or generated summary with operator
    instructions. Generated carry summaries deterministically extract bounded
    textual continuity from the abandoned path rather than copying raw
    context-entry messages. Context materialization admits only the latest
    active carry summary per fork point and keeps total branch-summary context
    inside the internal budget; older or over-budget summaries remain
    inspectable from tape/history.
  - tree rewind targets floor context entries to the nearest prior checkpoint
    when no exact checkpoint exists. The UI reports selected entry, effective
    checkpoint, and crossed context-entry count before applying rewind. The
    rewind escalation menu keeps conversation-only, code-only, conversation and
    code, and conversation and code with carried summary as separate choices.
  - `/lineage` opens the channel-local lineage tree, records advisory selection
    on checkout, and refreshes the visible transcript from the selected
    context-entry path
  - `/lineage` remains necessary as the macro topology surface for work
    branches, recovery, delegation, adoption, and channel-local selection; it is
    not replaced by `/tree`
  - unsupported interactive targets and low-capability full-screen terminals
    fail before shell boot instead of reviving a parallel renderer path
- `brewva inspect`: builds a schema-tagged work card for one replayable session
  from tape plus nearby artifact diagnostics by default; explicit
  diagnostic/raw modes expose the full drill-down, and it is not the live
  transport replay stream
- `--managed-tools direct`: keeps the same hosted lifecycle shape, but managed
  Brewva tools are provided directly by the host instead of being registered by
  the hosted behavior package; wiring details live in
  `docs/reference/extensions.md`
- Channel gateway (`--channel`): run adapter bridge loop; bind conversations to scopes, then scopes to agent sessions, and dispatch inbound turns serially per scope
  through the canonical hosted turn envelope using the `channel` hosted-loop
  profile

## Durability Boundaries

Session lifecycle behavior is anchored to the repository durability taxonomy:

- `durable source of truth`
  - event tape, checkpoints, reasoning-branch receipts, proposal receipts,
    approval events, task/claim events, and schedule intent events
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
- removing `session_compact` receipts does change replay correctness because
  they are the history-rewrite authority used to derive the inspect/context
  baseline on demand
- removing channel helper state must not break approval truth or exact resume
- removing Recovery WAL can affect in-flight recovery, but not historical truth

## Recovery Path

Target recovery order is:

1. canonicalize and diagnose recovery posture
2. hydrate replay-owned runtime state from tape
3. derive the history-view baseline from event tape
4. derive the recovery working set
5. resolve a hosted-loop decision from turn-local state and transition signals
6. admit context through the normal provider path when the decision streams or
   retries

Step 3 is not a projection-cache rebuild and does not read a history-view
artifact file. The history-view baseline is a receipt-derived view over
durable `session_compact` history, while working projection remains a separate
rebuildable snapshot.

Recovery posture is tape-derived. The first recovery pass detects replay-visible
open tool, open turn, and dangling producer/capability continuity conditions from
the event tape before fold state is rebuilt. Posture then folds from the canonical
recovery events (`turn.ended`, `runtime.suspended`, `checkpoint.committed`) into
the `recovery_history` projection; later canonical recovery events supersede an
earlier degraded posture rather than letting a process-local diagnostic pin the
session in permanent degradation.

- On `SIGINT`/`SIGTERM`, CLI interrupts the active runtime turn, waits for agent
  idle (bounded by graceful timeout), then exits.
- Next startup reconstructs replay-owned hydration state from event tape
  (`checkpoint + delta` replay), including skill catalog, tool-lifecycle,
  verification, resource-lease, cost, tape-ledger projection, reversible-mutation,
  and parallel-budget state.
- Projection rebuild remains a separate on-demand projection-engine path. It is
  not part of session hydration and it does not gate replay correctness.
- Reasoning-branch state is reconstructed from durable `reasoning_checkpoint`
  and `reasoning_revert` receipts. Recovery WAL does not hold the active
  branch; it only carries the in-flight turn envelope.
- Session-local runtime state is hydrated lazily on first access. The first
  hydration may happen on `onUserInput()`, `onTurnStart()`, or a later
  inspect/read-model access that needs replay-owned state (skill/budget/cost
  counters, warning dedupe, ledger compaction cooldown).
- `onTurnStart()` remains the first canonical turn-boundary hook that both
  hydrates and advances per-turn runtime state such as context-budget turn
  bookkeeping.
- durable session teardown is separate from replay truth: on hosted
  `session_shutdown`, runtime records or reconciles the terminal receipt first,
  then clears session-local hydrated state, caches, turn clocks, and other
  rebuildable helpers through `HostedRuntimeAdapterPort.ops.session.state.clear(sessionId)`. Later
  inspection or replay rehydrates from tape again instead of depending on
  process-local leftovers.
- Recovery posture is derived from two bounded read models:
  - the history-view baseline, which is authority-anchored and scoped by the
    current reference-context digest
  - the recovery working set, which carries operational continuation state such
    as pending recovery family, open tool calls, and resume contract hints
- Gateway and frontend session replay do not consume raw event streams.
  Runtime-scoped replay uses `HostedRuntimeAdapterPort.ops.sessionWire`; gateway public
  replay uses the same runtime-owned compiler semantics against archived
  agent-session event logs. In both cases replay is compiled from durable
  receipts including `turn.input.recorded`, `turn.render.committed`, approval
  events, delegation receipts, canonical runtime events, and `session_shutdown`.
- `brewva inspect` is adjacent to that replay pipeline but not identical to it:
  the command builds an operator report from `HostedRuntimeAdapterPort.ops.events`,
  `HostedRuntimeAdapterPort.ops.session`, `HostedRuntimeAdapterPort.ops.recovery`,
  and nearby artifact checks instead of subscribing to
  `HostedRuntimeAdapterPort.ops.sessionWire`.
- Live gateway preview traffic remains cache-class and transport-owned. In the
  current wire, live tool frames are explicitly attempt-scoped through
  authoritative tool lifecycle binding, while replay remains committed-state
  only.
- runtime lifecycle aggregate sits between projection-local rebuildable state and
  presentation adapters. Hydration folds, approval hydration, recovery posture,
  canonical runtime causes, and open tool-call state remain projection-local; the
  aggregate snapshot composes them into one posture contract for gateway
  status, host bootstrap, and policy adapters.
- Gateway public-session lookup is also durable: the gateway records
  `gateway_session_bound` receipts on a control tape so archived replay does
  not depend on process-local binding memory.
- malformed or unreadable event tape rows degrade hydration status and surface
  explicit `event_tape` integrity issues instead of being treated as an empty
  healthy tape.
- Note: upstream `turnIndex` can reset to `0` on `agent_start` boundaries. Brewva normalizes turns to be monotonic per session (for example `effectiveTurn = max(current, turnIndex)`) and uses the normalized value for gating/reconciliation.
- If projection artifacts are missing, runtime rebuilds projection state on
  demand from durable tape replay through deterministic `RuntimeTape` projection
  folds; there is no separate projection-engine ingest/refresh telemetry.
- That projection rebuild does not recreate history authority on its own. The
  history-view baseline still comes from durable `session_compact` receipts or
  a completed reasoning branch reset, plus reference-context compatibility
  checks. If no compatible receipt-backed baseline exists,
  `HostedRuntimeAdapterPort.ops.context.prompt.getHistoryViewBaseline(...)` can still expose a bounded
  `exact_history` continuity snapshot rebuilt from the surviving branch's
  `turn.input.recorded` / `turn.render.committed` history, but that fallback is
  not a replacement for receipt-backed history rewrite authority.
- Reasoning rewind is expressed as explicit model/kernel state and projected from
  tape-visible receipts. The default turn implementation recognizes only approval
  suspension, compaction pressure, zero-frame provider retry, interrupt, and
  terminal commit.
- Channel approval helper state is not part of recovery correctness.
  Approval claims and request resolution remain replay-derived from durable
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
- `channel_turn_ingested` is bridge telemetry emitted after dispatcher-owned
  `appendPending(...)` durably accepts the inbound turn, but before any hosted
  execution completes; it marks ingress admission order rather than success.
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
- `HostedRuntimeAdapterPort.ops.session.lifecycle.getIntegrity(sessionId)` is the
  canonical operator-facing health read model: it aggregates every durability
  dimension into one status surface. It folds `event_tape` (a forensic tape scan),
  `recovery_wal` (the store's fail-closed quarantine guard, the same signal the
  inspect `recoveryWal` block reads), `ledger` (candidate ledger chain
  verification), and `artifact` (tape-referenced world manifests and blobs hash
  verified). Any
  unhealthy dimension yields `degraded` with the offending dimension's issues
  surfaced in the `brewva inspect` `integrity` block; `healthy` requires all
  dimensions verified clean; and `inconclusive` is reserved for an incomplete
  check (for example, the event tape is disabled or a durability store is unreadable).
