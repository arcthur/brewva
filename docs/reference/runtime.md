# Reference: Runtime Contract

Primary implementation anchors:

- `packages/brewva-runtime/src/runtime/runtime.ts`
- `packages/brewva-runtime/src/runtime/runtime-api.ts`
- `docs/research/decisions/four-port-runtime-simplification-rfc.md`
- `docs/reference/proposal-boundary.md`

## Role

`createBrewvaRuntime(...)` returns one frozen `BrewvaRuntime` object. The public
runtime contract is the four-port constitutional shape:

- `runtime.tape` owns committed truth, replay baselines, canonical events, and
  deterministic projections.
- `runtime.kernel` owns authorization, approval requests, tool commitments, and
  commit or abort receipts.
- `runtime.model` owns working-memory materialization and checkpoint candidate
  construction.
- `runtime.turn(...)` owns provider physics, context pressure, retry boundaries,
  runtime suspension, and terminal turn commit.

The root no longer exposes `root`, `hosted`, `tool`, `operator`, `authority`, or
`inspect`. New runtime-facing code must use the four-port root directly.

## Stable Root Shape

```ts
interface BrewvaRuntime {
  readonly identity: BrewvaRuntimeIdentity;
  readonly config: DeepReadonly<BrewvaConfig>;
  readonly tape: TapePort;
  readonly kernel: KernelPort;
  readonly model: ModelPort;

  start(): Promise<RuntimeStartReceipt>;
  turn(input: TurnInput): AsyncIterable<TurnFrame>;
  close(): Promise<void>;
}
```

`identity` holds `{ cwd, workspaceRoot, agentId }` as read-only runtime facts.
`config` is a deep-readonly snapshot after normalization.

Runtime provider and tool execution adapters are physics dependencies, not root
ports. `BrewvaRuntimeOptions.physics` is required and declares exactly how turn
execution may touch the world:

- `mode: "real"` requires a provider and tool executor, and may commit new
  canonical events.
- `mode: "replay"` takes a source event stream, disables durable tape writes,
  rejects provider/tool executor ports, and emits only recorded runtime events.
- `mode: "replay-then-real"` replays a cloned prefix into an explicit fork
  target, then continues through real provider/tool execution. It never writes
  divergent events to the source session's tape.
- `mode: "noop"` constructs the ports for tests and hosted assembly, but
  `runtime.turn(...)` fails before committing turn events.

Callers observe all physics effects only through streamed `TurnFrame`s and
canonical tape events.

## Canonical Tape

Runtime truth is recorded through a compact canonical event vocabulary:

```ts
type CanonicalEventType =
  | "turn.started"
  | "turn.ended"
  | "msg.committed"
  | "reason.committed"
  | "tool.proposed"
  | "tool.started"
  | "tool.committed"
  | "tool.aborted"
  | "checkpoint.committed"
  | "anchor.committed"
  | "approval.requested"
  | "approval.decided"
  | "cost.observed"
  | "runtime.suspended"
  | "custom";
```

`custom` events must carry `namespace`, `kind`, `version`, `authority`, and an
opaque `payload`. Custom events do not affect built-in projections unless an
explicit projector admits that namespace.

The four-port runtime stores canonical tape under `runtime.config.tape.dir`
(`.brewva/tape` by default) when `runtime.config.tape.enabled` is true. This is
the only persistent event plane for replay. `infrastructure.events.enabled` and
`infrastructure.events.level` control advisory read-model recording, not a
second JSONL location. Runtime startup validates canonical tape and fails fast
on non-canonical rows inside `tape.dir`.

Built-in projections are deterministic folds over canonical tape:

- `turn_state`
- `tool_commitments`
- `step_projection`
- `recovery_history`
- `cost_summary`
- `baseline`

`checkpoint.committed` carries the compact summary plus source event ids, not a
recursive copy of every source event. `tape.replayBaseline(sessionId)` starts
from the latest checkpoint and includes only the compact baseline plus later
events, so Model can reduce context pressure without creating a second truth
store.

## Tool Transaction Boundary

The stable transaction boundary is `single tool-call granularity`.

`kernel.beginToolCall(...)` records `tool.proposed` for allowed calls, records
`tool.aborted` for blocked calls, or records `approval.requested` for deferred
calls. Runtime engine code executes approved commitments and completes them
through `kernel.commitToolResult(...)`; abort paths complete through
`kernel.abortToolCall(...)`.

Kernel does not execute tools. Runtime owns tool process lifetime, abort
signals, parallel leases, provider loops, and cost observations. Provider tool
frames are converted into `kernel.beginToolCall(...)` decisions. Approved
commitments execute through the runtime tool executor and complete through
`kernel.commitToolResult(...)`; missing or failed executors abort through
`kernel.abortToolCall(...)`.

Committed tool results carry top-level `result.outcome` as the canonical domain
truth. Outcome kinds are `ok`, `err`, and `inconclusive`; only `err` projects to
external binary `isError: true`. Adapter-only fields such as `result.isError`
and `result.details`, plus legacy `result.ok`, are rejected before a
`tool.committed` payload can become tape truth. Outcome payloads must be
JSON-compatible and match the tool's declared output or error schema before the
hosted executor commits them.

`runtime.tape.project(sessionId, "step_projection")` joins `tool.proposed`,
`tool.committed`, and `tool.aborted` into rebuildable step records. The
projection derives effects, action class, receipt policy, and recovery policy
from the authority payload recorded before execution; realized outcome kind and
version come from the committed result. It stores redacted stable hashes for
inputs and outputs instead of expanding raw payloads, and it never becomes a
second replay truth store.

Runtime does not expose a stable public contract for cross-agent recovery. No
cross-agent saga semantics, generalized compensation graphs, or broad
all-or-nothing control-plane transactions are provided. Hosted orchestration,
scheduler triggers, and delegated runs remain opt-in control-plane behavior over
kernel receipts.

Kernel also owns the only non-commitment custom event writer:
`kernel.recordAdvisoryEvent(...)`. It always records `custom` with
`authority: "advisory"` and cannot emit turn, tool, checkpoint, approval, cost,
or runtime terminal facts. Gateway/channel/daemon operational telemetry uses
this path so those facts are replayable without exposing `TapeCommitPort` or
recreating a second event store.

## Verification Semantics

default verification checks are expanded per target root for multi-root tasks.
command-backed checks only become authoritative after `brewva_verify` records
fresh evidence for the relevant target root.

ordinary verifier blockers are verification debt rather than hard runtime
blockers. They should be projected from tape and surfaced to operators, but they
do not widen the default runtime transaction boundary beyond one tool call.

Verifier adapters are advisory by default. A verifier result can influence
kernel admission only when a schema-tagged verification gate manifest is
evaluated into `ToolCallProposal.verificationGates`. That policy input binds
adapter, target roots, patch/evidence refs, freshness, and missing, stale, or
failed posture. Adapters never call `kernel.beginToolCall(...)` or mutate
approval state directly.

## Recovery Causes

The default runtime loop recognizes only five recovery causes:

```ts
type RuntimeRecoveryCause =
  | "approval_pending"
  | "compaction_required"
  | "provider_retry"
  | "interrupt"
  | "terminal_commit";
```

Hosted recovery decision matrices, breaker families, attempt supersession
policies, and reasoning-revert-resume state machines must not become default
runtime concepts again. They either become canonical tape projections, explicit
tools, or deleted legacy code.

## Generated Surface

<!-- generated:runtime-surface start -->

> Generated by `bun run docs:inventory`. Do not edit this block by hand.

Runtime root member count: 8. Public semantic ports: 3. Lifecycle methods: 3.
Budget: root <= 8; canonical event types <= 15.

- `runtime.close`
- `runtime.config`
- `runtime.identity`
- `runtime.kernel`
- `runtime.model`
- `runtime.start`
- `runtime.tape`
- `runtime.turn`
<!-- generated:runtime-surface end -->

## Effect Boundary

Effect remains infrastructure, not public runtime API. Public runtime types must
not expose Effect values or require callers to understand Effect layers. The
runtime package must stay plain TypeScript and must not import raw Effect,
Effect primitive aliases, or semantic Effect services.

Effect is allowed in infrastructure islands that need resource ownership:
provider-core streams, gateway channel and daemon mechanics, tool execution
process management, substrate plugin guards, ingress, and worker operations.
Those islands should keep stream, queue, schedule, retry, and finalizer logic
Effect-native until a declared adapter boundary maps the result back to a
Promise or async iterable.

When an infrastructure island needs a long-lived service plus a Promise-facing
adapter, it should use `createBrewvaServiceRuntime(...)` from
`@brewva/brewva-effect/runtime`. That keeps scoped service construction,
finalizers, and boundary execution in one shared foundation path instead of
repeating package-local Scope/ManagedRuntime wiring.

`runBoundaryOperation` is an edge adapter tool, not a general helper. It belongs
only in the Effect foundation, testing helpers, and declared adapter files
covered by fitness tests. Runtime turn handoffs use the plain TypeScript
`createAsyncBridge(...)` utility for backpressure, abort, failure, close, and
early-consumer-exit cleanup.
