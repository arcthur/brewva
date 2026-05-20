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

Runtime provider and tool execution adapters are construction dependencies, not
root ports. `BrewvaRuntimeOptions.provider` supplies the provider stream consumed
by `runtime.turn(...)`; `BrewvaRuntimeOptions.toolExecutor` executes approved
tool commitments. Both are runtime physics, so callers observe their effects
only through streamed `TurnFrame`s and canonical tape events.

## Canonical Tape

Runtime truth is recorded through a compact canonical event vocabulary:

```ts
type CanonicalEventType =
  | "turn.started"
  | "turn.ended"
  | "msg.committed"
  | "reason.committed"
  | "tool.proposed"
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
Budget: root <= 8; canonical event types <= 14.

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

Effect remains infrastructure, not public runtime API. It may own resource
scope, dependency layers, cancellation, retry, and concurrency adapters inside
the assembly. Public runtime types must not expose Effect values or require
callers to understand Effect layers.

After the four-port ownership cut stabilizes, remaining Effect usage should be
audited for whether it is serving real infrastructure needs or only preserving
shallow seams from the old domain lattice.
