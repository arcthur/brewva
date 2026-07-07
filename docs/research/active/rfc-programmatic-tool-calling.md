# RFC: Programmatic Tool Calling — Declarative Tool Chains With Out-Of-Context Intermediate Results

## Metadata

- Status: active
- Implementation state: Phase 1 landed against a green `bun run check` and full
  test suite — read-only `tool_chain` in the execution family, the
  `observe_compound` action class, the `tool_chain.result.recorded` receipt
  (schema `brewva.tool-chain.v1`) carrying bounded per-step result previews, and the
  transaction-boundary fitness. Phase 2 (effectful steps, per-step kernel
  admission) and Phase 3 (conditional steps) remain gated. Promotion is blocked
  only on the measurable context-economy signal, which needs real adoption data.
- Owner: Runtime, tools, and gateway maintainers
- Last reviewed: `2026-07-07`
- Depends on:
  - [Decision: Consequence-Aware Effect Commitment Model](../decisions/consequence-aware-effect-commitment-model.md)
    (receipt per committed effect; the per-step receipt invariant this RFC preserves)
  - [Decision: Model-Operated Working Memory And Context Governance Reset](../decisions/model-operated-working-memory-and-context-governance-reset.md)
    (`Model owns attention`; the model decides when to batch vs call individually)
  - `docs/architecture/design-axioms.md` (axioms 1, 4, 17 — the authority
    boundaries this RFC is filtered through)
  - `docs/journeys/internal/context-and-compaction.md` (compaction pressure;
    the primary cost this RFC reduces)
- Promotion target:
  - `docs/reference/tools.md` (tool contract)
  - `docs/reference/tools/execution.md` (execution family)
  - `docs/journeys/internal/context-and-compaction.md` (context economy impact)
  - `docs/architecture/system-architecture.md` (transaction boundary note)

## Problem Statement

When a model needs to execute a sequence of read-only tools to gather context
(for example, `grep` for a pattern, `read` matching files, `grep` again to
narrow results, `read` a specific section), each tool call round-trips through
the model's context window. In a typical debugging or exploration scenario, the
model may issue 10+ sequential tool calls before reaching an actionable
conclusion. Every intermediate tool result — the full grep output, the full file
content, the narrowed results — stays in context, consuming tokens that
accelerate compaction pressure and crowd out relevant context.

A peer harness (`hermes-agent`) addresses this with a `code_execution_tool` that
lets the model write a Python script calling tools over RPC; intermediate tool
results never enter the model's context, only the script's final stdout
returns. This converts N tool round-trips into one inference turn, saving an
estimated 60-80% of context tokens in search-heavy scenarios.

Brewva has no equivalent mechanism. A `grep` for `tool_program|programmatic|
tool_chain|batch_tool` across the entire `packages/` tree returns no matches.
Every managed tool call — whether a 5-line grep or a 2000-line file read —
enters context as a full tool-result message and stays there until compaction
or workbench eviction. The model can call `workbench_evict` after the fact, but
the token cost is already incurred on the outbound provider request, and the
eviction itself consumes a turn.

The gap is not about authority — brewva's kernel already authorizes each tool
call individually with receipts. The gap is about **context economy**: the model
has no way to execute a bounded tool sequence where intermediate results are
receipt-bearing (preserving tape accountability) but not context-bearing
(preserving context budget).

## Scope Boundaries

In scope:

- a new managed tool (`tool_chain` or `tool_program`) that accepts a declarative
  sequence of tool invocations and executes them in a sandbox-like envelope
- per-step advisory receipt emission (each internal step emits its own
  `tool.result.recorded` receipt; in Phase 1 the envelope is one kernel
  transaction and the steps are direct dispatches, not per-step commitments)
- returning only a bounded final result (or a specified subset of step results)
  to the model's context, not the full intermediate transcript
- the action-class, capability-scoping, and admission policy for the compound
  envelope

Out of scope:

- arbitrary code execution (this is a declarative tool chain, not a scripting
  engine — no `eval`, no dynamic imports, no shell escapes)
- changing the `single tool call` transaction boundary (in Phase 1 the envelope
  _is_ the single kernel transaction; the internal read-only steps are direct
  dispatches with advisory receipts, not an authority bypass. Phase 2's
  effectful steps re-introduce per-step commitment behind their own gate)
- auto-chaining (the runtime never assembles chains for the model; the model
  authors the chain explicitly)
- cross-session chain replay (the chain is turn-scoped; receipts persist on
  tape but the chain itself is not a durable artifact)
- replacing existing tools (individual tool calls remain the default path; the
  chain is opt-in)

Out of scope but tracked:

- conditional step logic (if-step-then-branch) — a future extension if the
  declarative form proves insufficient; the initial version is a flat sequence
  with optional result filtering
- a `tool_chain_replay` inspect surface for operators to review what the chain
  did internally — useful for debugging but not blocking

## Why

### Why this is the highest-impact remaining harness gap

A comparative analysis of three harnesses (brewva, `claude-code`, `hermes-agent`)
found that brewva already implements most major harness mechanisms — goal
continuation, mid-turn steer, failure recurrence evidence, stall adjudication,
trace-driven improvement, verification receipt plane — at or above peer quality.
The one mechanism brewva entirely lacks is programmatic tool calling.

In search-heavy workflows (debugging, codebase exploration, multi-file refactors),
intermediate tool results are **evidence the model needs transiently but not
durably**. The model reads a grep output to decide which file to read next; once
it has read the file, the grep output is dead weight in context. Today, that
dead weight accumulates until compaction, consuming context budget that could
hold more decision-relevant content.

### Why a declarative chain, not a scripting engine

Hermes lets the model write arbitrary Python that calls tools over RPC. This is
powerful but introduces a trust boundary: the script can loop, branch, call
external APIs, and produce side effects that are hard to attribute. Brewva's
axioms require that every effect is kernel-authorized with a receipt (axiom 5)
and that the transaction boundary stays `single tool call` (axiom 17). A
declarative chain — a JSON array of `{tool, args}` steps — preserves both: the
envelope is one kernel transaction, each step is a discrete
statically-analyzable read with its own advisory receipt, and there is no
ambient execution capability.

### Why this does not violate the axioms

- **Axiom 1 (Model owns attention):** The model decides when to use a chain vs
  individual calls. The runtime does not auto-batch.
- **Axiom 4 (Govern effects, not thought paths):** The kernel governs each
  internal call's effect class and authorization. The chain is an execution
  envelope, not a reasoning prescription.
- **Axiom 5 (Every commitment has a receipt):** Each internal step produces an
  advisory `tool.result.recorded` receipt on the tape; the chain envelope
  produces its own `tool_chain.result.recorded` receipt recording the step list
  and final result. Every step stays inspectable after the turn.
- **Axiom 17 (Platform growth stays opt-in):** In Phase 1 the chain is a
  _single_ kernel transaction, so the `single tool call` boundary is preserved,
  not stretched — the chain literally _is_ one tool call. Existing tools and
  individual calls are unaffected. (Phase 2's per-step admission is the point
  where the boundary is genuinely pressured; it lands behind its own gate and
  its own fitness test — see Validation Signals.)

## Direction

1. **Declarative, not imperative.** The chain is a JSON array of steps. Each
   step names a tool and provides args. No control flow, no loops, no
   conditionals in the initial version. The model authors the chain explicitly;
   the runtime executes it sequentially.

2. **One kernel transaction, advisory receipt per step (Phase 1).** In the
   read-only phase the chain is a _single_ kernel transaction: `tool_chain`
   itself is admitted once (one `tool.proposed` → one `tool.committed`) and
   dispatches each internal tool's implementation directly, emitting a per-step
   advisory `tool.result.recorded` receipt (a `custom`/advisory tape event) for
   each. Intermediate steps deliberately do **not** emit a canonical
   `tool.committed` — that is exactly what keeps them out of context (see
   Architectural Positions). The envelope emits one `tool_chain.result.recorded`
   receipt recording the step list, per-step verdicts, and the return
   selection. Only the final result (or a model-specified subset) is surfaced as
   the tool-call return. Per-step _kernel admission_ (each internal call getting
   its own `tool.proposed` decision) is deferred to Phase 2, where it is
   actually needed.

3. **Read-only by default, effectful opt-in.** Phase 1 restricts steps to
   read-only action classes (`workspace_read`, `runtime_observe`, and
   `local_exec_readonly`). Effectful classes (`workspace_patch`,
   `local_exec_effectful`, `memory_write`, `control_state_mutation`,
   `external_side_effect`) are excluded until the Phase 2 per-step admission
   model lands. The read-only restriction is what makes single-transaction
   admission safe: a chain of reads cannot mutate the world, so admitting the
   envelope once — rather than re-admitting every step — bounds the blast radius
   without weakening any effect gate.

4. **Bounded result.** The returned result is subject to the same
   distillation and truncation rules as any tool result. The model can specify
   which steps' results to include (`returnSteps: [last]`, `returnSteps: [3,
5]`, `returnSteps: all`); the default is `last` only.

## Architectural Positions

- **The chain is a compound execution envelope, not a compound transaction.**
  In Phase 1 the envelope is admitted as one kernel transaction and runs the
  internal read-only steps in sequence, each leaving an advisory receipt. The
  chain does not create a saga, a compensation graph, or a partial-failure
  repair path. If step 3 of 5 fails, steps 1-2 already have advisory receipts,
  step 3 has a failure receipt, steps 4-5 are not executed, and the envelope's
  single `tool.committed` reports per-step verdicts so the model can decide what
  to do next. Because the internal steps are read-only, there is nothing to
  compensate — the absence of a saga is a property of the read-only restriction,
  not a promise the envelope has to keep.

- **The chain is capability-scoped.** The chain inherits the calling
  session's capability set. Each step's tool must be in the session's
  admitted managed-tool set. The chain does not expand authority; it batches
  already-authorized tools.

- **Intermediate results are tape-evident but context-absent — by
  construction.** Brewva materializes conversation messages _only_ from
  canonical `tool.committed` events (`packages/brewva-runtime/src/runtime/model/impl.ts`,
  `promptMessagesFromEvent`); the advisory `tool.result.recorded` receipt is a
  `custom` tape event the materializer never reads, yet `replayBaseline` keeps
  it on the tape. So a step that emits only an advisory receipt is inspectable
  on replay but invisible to the next prompt. The single lever controlling
  context injection is whether a canonical `tool.committed` is written — the
  chain commits exactly one (its surfaced return) and emits advisory receipts
  for the rest. No change to the materializer is required; this is why the
  context-economy win is cheap.

- **The chain is turn-scoped.** The chain executes within the calling turn.
  It does not span turns, does not survive compaction as a chain, and does
  not create a durable chain artifact. The per-step receipts persist on tape;
  the chain envelope receipt persists on tape; the chain itself is not a
  resumable entity.

## Source Anchors

Stable docs and decisions:
`docs/architecture/design-axioms.md` (axioms 1, 4, 5, 17),
`docs/architecture/system-architecture.md` (transaction boundary),
`docs/research/decisions/consequence-aware-effect-commitment-model.md`,
`docs/research/decisions/model-operated-working-memory-and-context-governance-reset.md`.

Internal implementation anchors:

- `packages/brewva-tools/src/families/execution/` (execution tool family; the
  natural home for the new tool)
- `packages/brewva-tools/src/contracts/` (tool contract types; the chain tool
  definition follows the same `BrewvaToolDefinition` pattern)
- `packages/brewva-tools/src/registry/runtime-bound-tool.ts` (runtime-bound
  tool factory; the chain tool uses this to access the managed tool registry)
- `packages/brewva-runtime/src/runtime/turn/impl.ts` and
  `packages/brewva-runtime/src/runtime/kernel/impl.ts` (the kernel gate —
  `beginToolCall` / `commitToolResult` — that admits the `tool_chain` envelope
  once in Phase 1, and that Phase 2's per-step admission would re-enter; note
  `actionClass` rides on `tool.proposed`, not `tool.committed`)
- `packages/brewva-vocabulary/src/internal/iteration.ts` (`tool.result.recorded`
  event vocabulary; the chain receipt extends this family)
- `packages/brewva-gateway/src/hosted/internal/session/managed-agent/session.ts`
  (hosted session; the chain executes in the session's tool executor)

External comparison anchor (mechanism only, not attention-ownership stance):
`/Users/bytedance/new_py/hermes-agent/tools/code_execution_tool.py`
(programmatic tool calling over UDS/file RPC; intermediate results kept out of
context). Note: hermes counts each programmatic tool call against the _same_
shared iteration budget as foreground calls — there is no refund or carve-out.
The brewva win here is context economy, not budget economy; this RFC promises no
budget refund.

## Architecture Proposal

### 1. Tool Definition

A new managed tool `tool_chain` in the `execution` family:

```typescript
{
  name: "tool_chain",
  label: "Tool Chain",
  description:
    "Execute a sequence of read-only tools in one call. " +
    "Intermediate results are recorded on tape but do not enter context. " +
    "Only the specified step results are returned.",
  actionClass: "observe_compound",
  parameters: Type.Object({
    steps: Type.Array(
      Type.Object({
        tool: Type.String(),          // managed tool name
        args: Type.Record(Type.String(), Type.Unknown()), // tool args
        label: Type.Optional(Type.String()), // human-readable step label
      }),
      { maxItems: 20 }                 // bounded chain length
    ),
    returnSteps: Type.Union([
      Type.Literal("last"),            // default: only the last step's result
      Type.Literal("all"),             // all step results
      Type.Array(Type.Number()),       // specific step indices
    ]),
  }),
}
```

### 2. Execution Envelope (Phase 1, read-only, single transaction)

1. `tool_chain` is admitted once through the normal kernel gate
   (`tool.proposed` → decision → `tool.committed`), like any other tool. Its
   own action class is `observe_compound` (see How To Implement).
2. For each step, inside the envelope's execution:
   a. Resolve the named tool from the managed-tool registry.
   b. Validate the tool is in the session's admitted capability set.
   c. Validate the tool's action class is read-only (`workspace_read`,
   `runtime_observe`, or `local_exec_readonly`); Phase 1 rejects any effectful
   class.
   d. Invoke the tool's implementation directly — not a re-entrant kernel
   commitment (see the boundary note in How To Implement).
   e. Emit an advisory `tool.result.recorded` receipt for the step (a `custom`
   tape event, not a canonical `tool.committed`, so it stays out of context).
   f. If the step verdict is `fail`, stop the chain and carry the failure point
   into the envelope's return.
3. After all steps complete (or the chain stops early):
   a. Select the return result based on `returnSteps`.
   b. Emit one `tool_chain.result.recorded` receipt with the step list,
   per-step verdicts, and the return selection.
   c. Return the selected result(s) as the single `tool.committed` result for
   the envelope — the only step whose output enters context.

### 3. Receipt Vocabulary

A new vocabulary event `tool_chain.result.recorded` (schema
`brewva.tool-chain.v1`):

- `chainId`: deterministic id from the step list hash
- `steps`: array of `{ tool, argsDigest, verdict, receiptEventId }`
- `returnSelection`: which steps' results were returned
- `returnResult`: the bounded final result text

Per-step `tool.result.recorded` events are emitted as normal; the chain
receipt cross-references them by event id.

### 4. Result Bounding

The returned result is subject to the existing tool-result distillation
pipeline. If the selected result exceeds the distillation threshold, it is
summarized the same way a large individual tool result would be. The chain
does not bypass distillation.

## How To Implement

### Phase 0: Boundary confirmation

- **Re-entrancy does not exist today, and Phase 1 deliberately avoids needing
  it.** A tool's executor receives a `BrewvaToolContext`
  (`packages/brewva-substrate/src/contracts/tool.ts`) with no kernel handle and
  no tool registry; the only "tool triggers more work" path is
  `orchestration.subagents.run`, which spawns a full sub-agent session, not an
  in-turn kernel call. Phase 1 therefore dispatches internal tool
  _implementations_ directly from inside the `tool_chain` executor and records
  advisory receipts — no new kernel surface. Confirm the executor can resolve a
  managed tool's implementation by name from the registry it is constructed
  with.
- Add `observe_compound` as a new `ToolActionClass`
  (`packages/brewva-runtime/src/governance/policy-types.ts`), a matching entry
  in `TOOL_ACTION_POLICY_BY_CLASS`
  (`.../kernel/policy/tool-admission-policy.ts`), and satisfy the exhaustiveness
  check in `config/normalize-integrations.ts`. Do not overload `runtime_observe`
  with a flag — the compound envelope has a distinct admission posture (it may
  fan out over many reads) and deserves its own class.
- Confirm the advisory-receipt seam: internal steps emit through the existing
  `tool.result.recorded` advisory path
  (`packages/brewva-gateway/.../runtime-ops-builders/tools.ts`), which already
  writes a `custom` event the materializer ignores.

### Phase 1: Read-only chain, final-result-only

- Implement `tool_chain` with a per-step read-only action-class restriction
  (`workspace_read`, `runtime_observe`, `local_exec_readonly`).
- `returnSteps` defaults to `"last"`; `"all"` and explicit indices are
  supported.
- `maxItems: 20` step cap.
- Per-step receipts on tape; chain receipt on tape.
- Fitness: each step produces a `tool.result.recorded` receipt; the chain
  receipt cross-references them; replay shows per-step results even though
  the model only saw the final return.

### Phase 2: Effectful step support (gated — this is where per-step admission lands)

- Effectful steps cannot ride the single-transaction model: a `workspace_patch`
  or `local_exec_effectful` step must be individually kernel-admitted (its own
  `tool.proposed` decision, its own approval cycle, its own canonical
  `tool.committed`). This is the point where the RFC genuinely needs a
  re-entrant tool-invocation capability threaded into the executor/runtime — and
  where the `single tool call` boundary is actually pressured.
- Design that seam explicitly: a scoped kernel handle passed into the envelope
  that can drive `beginToolCall` / `commitToolResult` for a named child, so each
  effectful step is a real commitment with its own approval and receipt. An
  effectful step that commits `tool.committed` will (correctly) surface into
  context — effectful results are not the ones we are trying to hide.
- Gate: Phase 2 lands only after Phase 1 is measurably adopted, the re-entrancy
  seam has its own fitness coverage, and the per-step approval overhead is
  acceptable.

### Phase 3: Conditional steps (gated, optional)

- Support a `condition` field on steps: `{ tool, args, condition: "step[2].verdict == 'pass'" }`.
- Conditions are evaluated against the in-chain step results, not against
  session state or model context.
- Gate: only if Phase 1 proves the declarative form is too rigid for real
  workflows.

## Validation Signals

- Receipt fitness: each step emits a `tool.result.recorded` receipt; the chain
  emits a `tool_chain.result.recorded` receipt; replay shows all per-step
  results even though the model only saw the final return.
- Authority fitness: the envelope is kernel-authorized once as
  `observe_compound`; each step is gated by the read-only action-class allowlist
  and the session's capability scope, so the chain cannot batch anything the
  model could not have called individually and cannot reach an effectful tool.
- Context fitness: only the selected return result enters the model's
  conversation messages; intermediate results are tape-evident but
  context-absent.
- Boundary fitness: the chain is bounded (`maxItems: 20`); effectful tools are
  excluded in Phase 1; the chain is turn-scoped and not resumable.
- Transaction-boundary fitness (axiom 17/19): a Phase 1 chain emits exactly one
  canonical `tool.committed` (the envelope's return) and zero for its internal
  steps — asserted by a test, so the `envelope, not compound transaction`
  invariant is checked, not merely documented. This is the fitness artifact
  axiom 19 requires for the otherwise-unenforced `single tool call` boundary.
- Distillation fitness: the returned result is subject to the same
  distillation pipeline as any tool result.
- `bun run check` and the full `bun test` suite both green.

## Surface Budget

| Surface                               | Before | After | Notes                                                               |
| ------------------------------------- | -----: | ----: | ------------------------------------------------------------------- |
| Required authored fields              |      0 |     0 | No new configuration.                                               |
| Optional authored fields              |      0 |     0 | The chain is a model action, not config.                            |
| Author-facing concepts                |      0 |     1 | `tool_chain` as a compound execution envelope.                      |
| Persisted formats                     |      0 |     1 | `tool_chain.result.recorded` event (schema `brewva.tool-chain.v1`). |
| Inspect surfaces                      |      0 |     0 | Per-step results are visible through existing tape inspection.      |
| Public tools                          |      0 |    +1 | `tool_chain` managed tool.                                          |
| Routing/control-plane decision points |      0 |     0 | The chain reuses existing kernel authorization per step.            |

Positive surface delta:

- Debt owner: tools and runtime maintainers.
- Why unavoidable: the chain needs one new tool, one new receipt vocabulary
  event, and one author-facing concept. The per-step receipts reuse the
  existing `tool.result.recorded` vocabulary.
- Dated re-evaluation trigger: by `2026-10-01`, evaluate whether `tool_chain`
  measurably reduced context pressure (compaction frequency, average context
  usage) in sessions that adopted it vs sessions that did not.

## Promotion Criteria

Move to `docs/research/decisions/` only after:

- [x] Phase 1 is implemented and green: read-only chains with per-step receipts
      and final-result return.
- [ ] A measurable context-economy signal: sessions using `tool_chain` show
      lower compaction frequency or lower average context usage compared to
      equivalent sessions without it. **Open — needs real adoption data; this is the
      only remaining promotion blocker.**
- [x] The per-step receipt invariant holds under fitness: replay shows every
      step's result — a bounded preview carried as `resultText` (with
      `truncated`/`fullChars` markers) on the `tool_chain.result.recorded`
      receipt — even though the model only saw the final return.
- [x] Stable docs carry the `tool_chain` contract
      (`docs/reference/tools/execution.md`, plus the generated inventory in
      `docs/reference/tools.md`).

## Open Questions

- Should `tool_chain` support parallel steps (a `parallel: true` flag that
  executes steps concurrently when they have no data dependency), or should
  parallelism stay in the `subagent_fanout` domain?
- Should the chain return include per-step verdict metadata (which steps
  passed/failed) even when `returnSteps` is `"last"`, so the model can
  reason about the chain's internal progress?
- (Resolved) The chain records a bounded `resultText` preview per step on the
  tape (2000 chars, with `truncated`/`fullChars` markers) and passes the returned
  selection through the normal tool-result distillation. A future
  `tool_chain_replay` surface could reconstruct full step output if a reader ever
  needs it.
- Should the chain be available to delegated workers (navigator, explorer),
  or restricted to the parent session?

## Related Docs

- `docs/reference/tools.md`
- `docs/reference/tools/execution.md`
- `docs/journeys/internal/context-and-compaction.md`
- `docs/architecture/design-axioms.md`
- `docs/architecture/system-architecture.md`
