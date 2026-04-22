# Invariants And Reliability

This document captures runtime invariants that must remain true for safety,
recoverability, and observability.
Use it for non-negotiable properties, not as the full public event or session
contract.

## Invariant Set

## 1) Evidence Integrity Invariant

- Every persisted tool outcome must produce a ledger entry or an explicit failure record.
- Ledger row-level verification must remain valid for each session. The ledger
  validates row shape, local ordering, checkpoint metadata, and output hashes;
  it does not claim an immutable cryptographic chain.

Relevant implementation:

- `packages/brewva-runtime/src/runtime.ts`
- `packages/brewva-runtime/src/ledger/evidence-ledger.ts`

## 2) Event Observability Invariant

- Major lifecycle events (session, turn, tool, context, verification, cost) must be queryable via event store.
- Replay output must be derivable from persisted events only.
- Hosted continuation posture must be queryable through durable
  `session_turn_transition` events rather than inferred only from transient
  logs or prompt text.

Relevant implementation:

- `packages/brewva-runtime/src/events/store.ts`
- `packages/brewva-runtime/src/runtime.ts`
- `packages/brewva-cli/src/index.ts`

## 3) Recovery Consistency Invariant

- Runtime recovery state must be derivable from persisted event tape only
  (`checkpoint + delta` replay for task/truth/cost/evidence/projection, plus
  event-fold hydration for runtime session counters/budgets/compaction state).
- Process restart must not require opaque runtime snapshot blobs.
- Hosted bounded-recovery posture and breaker state must remain rebuildable from
  durable hosted transition events; process-local helpers may optimize the live
  path, but they must not become hidden authority or required recovery truth.

Relevant implementation:

- `packages/brewva-runtime/src/tape/replay-engine.ts`
- `packages/brewva-runtime/src/runtime.ts`

## 4) Commitment Replay And Exact-Binding Invariant

- `effect_commitment` approval state must remain replay-derived from tape, not
  from process-local approval memory.
- accepted commitment requests are consumed only after a durable linked
  `tool_result_recorded` outcome is observed.
- explicit resume must match the approved `requestId`, original `toolCallId`,
  and canonical argument identity (`argsDigest`).

Relevant implementation:

- `packages/brewva-runtime/src/services/tool-gate.ts`
- `packages/brewva-runtime/src/services/effect-commitment-desk.ts`
- `packages/brewva-runtime/src/services/ledger.ts`

## 5) Contract Enforcement Invariant

- Tool execution must respect active effect policy and effective resource ceilings before execution.
- Skill completion must enforce required outputs and verification checks.

Relevant implementation:

- `packages/brewva-runtime/src/security/tool-policy.ts`
- `packages/brewva-runtime/src/runtime.ts`
- `packages/brewva-tools/src/skill-complete.ts`

## 6) Rollback Safety Invariant

- Rollback must restore only tracked mutations for the target session.
- After successful rollback, verification state must be reset to avoid stale pass assumptions.

Relevant implementation:

- `packages/brewva-runtime/src/state/file-change-tracker.ts`
- `packages/brewva-runtime/src/services/mutation-rollback.ts`
- `packages/brewva-runtime/src/services/reversible-mutation.ts`
- `packages/brewva-runtime/src/runtime.ts`

## 7) Budget Boundedness Invariant

- Context injection must remain bounded by context budget policy.
- Cost summary and budget alerts must reflect session-level usage.

Relevant implementation:

- `packages/brewva-runtime/src/context/budget.ts`
- `packages/brewva-runtime/src/cost/tracker.ts`
- `packages/brewva-runtime/src/runtime.ts`

## 8) Config Immutability Invariant

- `runtime.config` must be deep-readonly after construction.
- constructor-time routing policies such as `routingScopes` and
  `routingDefaultScopes` must be applied before the runtime is assembled instead
  of by post-construction mutation.

Relevant implementation:

- `packages/brewva-runtime/src/runtime.ts`
- `packages/brewva-gateway/src/host/create-hosted-session.ts`
- `packages/brewva-gateway/src/host/hosted-session-bootstrap.ts`

## 9) Profile Transparency Invariant

- `managedToolMode=runtime_plugin` and `managedToolMode=direct` must be behaviorally
  explicit: the registration surface may differ, but core safety/evidence
  invariants must remain equivalent.
- When managed tools are provided directly, the hosted lifecycle chain still
  enforces effect policy, critical compaction gate, tool-call accounting, patch
  tracking, and tool-result ledger persistence.
- Core lifecycle and assistant-usage telemetry must still be persisted.

Relevant implementation:

- `packages/brewva-gateway/src/host/create-hosted-session.ts`
- `packages/brewva-gateway/src/host/hosted-session-bootstrap.ts`
- `packages/brewva-gateway/src/runtime-plugins/index.ts`

## 10) Working Projection Integrity Invariant

- Working projection must remain tape-derived and auditable:
  units and working snapshot are derived from event tape semantics, not an
  independent mutable `durable source of truth`.
- Projection events (`projection_*`) are operational/observational telemetry.
  They do not replace semantic projection rebuild inputs.
- Working-projection injection must be reproducible from persisted projection
  artifacts (or tape-driven rebuild outputs). If projection artifacts are
  missing, runtime rebuilds units from source tape events, then refreshes the
  working snapshot under the same context-budget policy.

Relevant implementation:

- `packages/brewva-runtime/src/projection/engine.ts`
- `packages/brewva-runtime/src/projection/store.ts`
- `packages/brewva-runtime/src/runtime.ts`
- `packages/brewva-tools/src/task-ledger.ts`

## Context Authority And Recall Ranking Model

Context governance is three-axis, not a single trust ladder:

- durability says whether a surface is final truth, crash/rollback material,
  rebuildable state, or cache
- `ContextAuthorityTier` says how an injected context source should be treated
  when it conflicts with another source
- recall `trustLabel`, `evidenceStrength`, and `rankingScore` explain broker
  result ordering inside advisory recall

The axes must stay separate from prompt-sanitization `SourceTrustTier`; trusted
formatting does not make a source authoritative.

### Durable Runtime Surfaces

| Surface         | Durability role                     | Recovery role                                        |
| --------------- | ----------------------------------- | ---------------------------------------------------- |
| Event tape      | durable source of truth             | replay and receipt linkage                           |
| Recovery WAL    | durable transient recovery material | turn/tool crash recovery                             |
| Evidence ledger | durable evidence / source-adjacent  | audit queries and row-level output hash verification |
| Projection      | rebuildable state                   | working view rebuilt from tape/workspace state       |

**Evidence ledger vs. tape fold**: the replay engine folds tape events for
recovery correctness. The evidence ledger stores local row-coherent audit
evidence for tool outcomes. Ledger and tape should agree, but the ledger is not
an immutable cryptographic chain and is not a substitute for replay truth.

### Injected Context Sources

| Context source                  | authorityTier      | selectionPriority | Budget class           |
| ------------------------------- | ------------------ | ----------------- | ---------------------- |
| `brewva.identity`               | operator_profile   | 10                | core                   |
| `brewva.agent-constitution`     | operator_profile   | 12                | core                   |
| `brewva.agent-memory`           | operator_profile   | 13                | core                   |
| `brewva.history-view-baseline`  | runtime_contract   | 14                | core (non-truncatable) |
| `brewva.runtime-status`         | runtime_read_model | 20                | core                   |
| `brewva.tool-outputs-distilled` | runtime_read_model | 30                | working                |
| `brewva.task-state`             | runtime_contract   | 40                | core                   |
| `brewva.recovery-working-set`   | working_state      | 45                | working                |
| `brewva.projection-working`     | working_state      | 50                | working                |

Agent identity, constitution, and memory are operator-authored profile inputs.
They are not deterministically rebuilt from event tape and must not be described
as derived runtime truth.

### Advisory Recall Sources

Advisory sources are injected only within the `recall` budget class, are
truncatable, and must not be continuity-critical. Rendered machine-generated
advisory content carries `verify_before_applying: yes`.

| Context source                   | selectionPriority | Notes                               |
| -------------------------------- | ----------------- | ----------------------------------- |
| `brewva.recall-broker`           | 14                | Targeted mixed-source retrieval     |
| `brewva.skill-routing`           | 15                | Session-state routing hints         |
| `brewva.narrative-memory`        | 42                | Machine-inferred lessons            |
| `brewva.deliberation-memory`     | 44                | Machine-inferred decision artifacts |
| `brewva.optimization-continuity` | 46                | Session optimization lineage        |
| `brewva.skill-promotion-drafts`  | 48                | Reviewable promotion candidates     |

Recall broker results rank by intent/source priority, `evidenceStrength`,
`semanticScore`, freshness, and curation into `rankingScore`. Tape search
distinguishes strong runtime receipts from weak task notes; repository precedent
can outrank weak tape notes, while strong runtime receipts can outrank
precedent. `recall_results_surfaced`, `context_*`, and `projection_*` are
durable evidence or rebuildable signals, not searchable recall evidence.

Relevant implementation:

- `packages/brewva-runtime/src/context/sources.ts`
- `packages/brewva-runtime/src/context/provider.ts`
- `packages/brewva-runtime/src/context/arena.ts`
- `packages/brewva-recall/src/context-provider.ts`
- `packages/brewva-recall/src/broker.ts`
- `packages/brewva-deliberation/src/narrative.ts`
- `packages/brewva-deliberation/src/memory.ts`
- `packages/brewva-deliberation/src/optimization.ts`
- `packages/brewva-skill-broker/src/broker.ts`

## Failure Modes and Containment

- Missing verification evidence: gate must block completion.
- Missing rollback state: return explicit `no_patchset`.
- Replay without events: return explicit no-session condition.
- Context hard-limit breach: drop injection and emit context drop event.
- Crash after external effect but before durable outcome persistence remains an
  explicit at-least-once boundary for approval-bound effectful tools.

## Reliability Validation

Tests under `test/unit/runtime/`, `test/contract/runtime/`, and
`test/contract/runtime-plugins/` validate these invariants.

## Related Docs

- `docs/architecture/design-axioms.md`
- `docs/architecture/system-architecture.md`
- `docs/reference/runtime.md`
- `docs/reference/events.md`
- `docs/reference/session-lifecycle.md`
