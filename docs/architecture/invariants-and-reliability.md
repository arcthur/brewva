# Invariants And Reliability

This page owns Brewva's non-negotiable safety and failure semantics. It is the
place to check whether a proposed change preserves replay, approval, rollback,
recovery, and bounded execution.

## Core Invariants

1. Evidence integrity:
   every persisted tool outcome must produce a ledger entry or explicit
   failure record.
2. Event observability:
   major lifecycle, tool, context, verification, and cost events must remain
   queryable.
3. Recovery consistency:
   runtime recovery state must be derivable from event tape plus bounded WAL or
   rollback material, not opaque snapshots.
4. Exact approval binding:
   approval state is replay-derived, and explicit resume must match request id,
   tool call id, and argument digest.
5. Contract enforcement:
   tools and skills must respect active effect policy, output contracts,
   routing scope, and resource ceilings before completion becomes
   authoritative.
6. Rollback safety:
   rollback restores only tracked mutations for the target session and resets
   stale verification assumptions.
7. Budget boundedness:
   context composition, provider cache behavior, cost reporting, and
   parallelism remain bounded by configured policy.
8. Config immutability:
   `runtime.config` is deep-readonly after construction; routing overrides are
   applied before runtime construction.
9. Projection integrity:
   working projection is rebuildable from tape/workspace state and never
   replaces event tape as truth.
10. Effect authority manifest:
    classifiers and overlays produce facts; the manifest-backed authority
    decision owns allow/block/defer meaning for a tool call.
11. Turn lifecycle monotonicity:
    hosted turn gates move forward only and never rewrite prior event tape.
12. Session lineage and context admission:
    branch topology, context-entry paths, and capability state are replay-derived;
    state-only records do not become model context without explicit admitted
    context entries, lineage summaries, or outcome adoption.
13. Effect infrastructure island:
    scopes, fibers, layers, schedules, streams, queues, and finalizers own
    in-memory infrastructure mechanics only; they never replace event tape,
    WAL, receipts, capability-scoped authority, or the plain TypeScript
    four-port runtime root.
14. Work Card projection safety:
    default inspect views aggregate existing evidence and preserve canonical
    refs, but opening shell, CLI, channel, or bundle inspect must not mutate
    tape, workbench, recall counters, capability selection, provider routing,
    or model attention inputs.
15. Advisory extension fail-closed:
    extension manifests must be schema-tagged, precedence-resolved, and
    ambient-capability checked. Unknown fields, unknown slots, unmanifested
    hosted extensions, and disallowed capability declarations fail closed.
16. Verification-gate authority path:
    verifier adapters are advisory by default. Kernel defer or abort behavior
    from verification evidence requires an explicit gate manifest converted
    into kernel policy input; adapters must not call admission or mutate
    approval state directly.
17. Typed honesty classes:
    lossy telemetry (provider cache and drift evidence) and durable replay facts
    are distinct phantom-branded types (`Durable`/`Lossy`/`Advisory`). A `Lossy<T>`
    can never satisfy a durable sink, and credential rotation enters the tape only
    as `Durable<T>`; mis-routing is a compile error, not a convention.
18. Pre-first-frame fallback gate:
    model fallback and credential rotation are reachable only behind a typed
    `NoFrame` witness proving no provider frame has streamed. Once the first frame
    streams (`SawFrame`), recovery is unrepresentable — the turn cannot rewrite
    itself mid-stream.
19. Checked structural invariants:
    a load-bearing runtime invariant is backed by a fitness or
    regenerate-and-diff artifact, not prose alone (axiom 19). The hosted
    turn-lifecycle-port order is fixed by named phase buckets
    (`HOSTED_LIFECYCLE_PHASES`); the `capability x plugin` authority inventory is a
    generated matrix (`host-plugin-capabilities.md`) diffed against code.
20. No second context-source authority:
    the capabilities whose effect class is context-write equal exactly
    `{context_messages.write}`, asserted as a positive allowlist over effect-tagged
    capability members — never a `*source*` / `register*` name denylist. The
    `hosted_behavior` capability set equals the set its journey doc documents, read
    from one source (drift guard, not minimality proof).
21. In-flight tool-identity binding:
    each canonical `tool.proposed` carries the advertised tool's identity hash, and
    the executor fails closed when the live tool surface drifts from that identity
    or when a `tool_call` names a tool never advertised in that request. The
    per-request `HarnessManifest` stays advisory audit correlation.

## Failure Semantics

- Missing projection files degrade working views but must not change replay
  truth.
- Missing or stale provider cache may cost tokens, but must not change
  authorization, recovery, or committed tool outcomes.
- Provider drift samples (`provider_drift_sample`, source `fallback_selection`;
  `transport_fallback` deferred) and cache-break observations are lossy diagnosis:
  projection-only for inspect, never replay authority, and never re-routed into a
  durable sink.
- Verifier blockers are visible verification debt until resolved; they do not
  silently become task truth.
- Missing attention option evidence produces fewer candidate cards, not hidden
  context injection. Consume, pin, ignore, and verify-plan actions must expose
  their own bounded effect posture.
- Missing, stale, or failed verifier evidence is advisory unless an explicit
  verification gate manifest declares the matching defer or abort posture.
- Extension manifest parse, precedence, or ambient-capability failures are
  diagnostics plus non-registration; lower-priority or malformed extensions do
  not override accepted manifests.
- Process-local hosted diagnostics may explain a fresh result but are not
  durable recovery truth.
- Deleted durable source-of-truth events change replay correctness and must be
  treated as data loss.
- Effect interruption and scope finalization are cleanup mechanics. Durable
  cancellation, rollback, recovery, and failure evidence must still be recorded
  through runtime events, receipts, WAL, or ledger rows when the boundary
  requires it.
- Both append-only logs are crash-safe at named boundaries: WAL compaction is an
  atomic `tmp`-write + `fsync` + `rename`, tape and WAL `fsync` at `turn.ended` /
  `checkpoint.committed` / terminal-WAL marks (`power_loss` durable there,
  `process_crash` durable between), a torn trailing line is truncated on load, and
  the durable write is the commit point — memory moves only after it succeeds, so a
  failed write leaves no ghost record. Recovery delivery is `at_least_once`.
- The unified `getIntegrity` durability aggregation folds every dimension into one
  status: `event_tape` (a forensic tape scan), `recovery_wal` (the WAL quarantine
  surface — a malformed row is isolated, refused by recovery, and reported through
  `brewva inspect`), `ledger` (candidate ledger chain verification), and `artifact`
  (tape-referenced world manifests and blobs hash verified). Any unhealthy dimension degrades the
  aggregate with per-dimension issues; `healthy` requires every dimension verified
  clean, and `inconclusive` is reserved for an incomplete check (for example, no
  durable tape substrate or an unreadable store). See
  `docs/journeys/internal/wal-and-crash-recovery.md`.
- Promise/Effect boundary crossings are adapter mechanics. Repeated boundary
  crossings inside provider stream core, channel queue core, tool execution
  internals, or runtime package code are reliability bugs, not implementation
  details.

## State Roles

| Surface         | Role                                | Failure posture                                                      |
| --------------- | ----------------------------------- | -------------------------------------------------------------------- |
| Event tape      | durable source of truth             | data loss affects replay correctness                                 |
| Recovery WAL    | durable transient recovery material | malformed rows quarantine; stale entries recover, expire, or compact |
| Evidence ledger | durable evidence                    | row issues degrade audit, not tape replay                            |
| Projection      | rebuildable state                   | rebuild from tape/workspace                                          |
| Work Card       | shared projection payload           | rebuild or render diagnostic drill-down                              |
| Attention cards | candidate projection                | omit or consume explicitly                                           |
| Session wire    | derived live/read model             | rebuild or degrade UI details                                        |
| Session lineage | rebuildable state                   | rebuild from tape                                                    |
| Provider cache  | performance cache                   | disable or miss without changing truth                               |

## Layer Ownership

The provider seam's layers each own exactly one thing. This table is the single
authority a reviewer points at when a control decision tries to migrate layers
(e.g. a provider-local retry creeping into the gateway loop, or a projection/cache
made authoritative).

| Layer         | Owns                                            | Must never own                                  |
| ------------- | ----------------------------------------------- | ----------------------------------------------- |
| provider-core | stream lifecycle, normalization, quirk table    | fallback, credential rotation, replay authority |
| gateway       | model fallback, credential rotation, drift sink | the normalized stream contract, replay truth    |
| tape          | replay authority (committed runtime facts)      | provider routing, optimization decisions        |
| cache plane   | a disposable, lossy efficiency plane            | replay authority; gating correctness            |

## Implementation Anchors

- `packages/brewva-runtime/src/runtime/runtime.ts`
- `packages/brewva-runtime/src/runtime/tape/impl.ts`
- `packages/brewva-runtime/src/runtime/kernel/impl.ts`
- `packages/brewva-runtime/src/runtime/kernel/policy/tool-decision.ts`
- `packages/brewva-cli/src/operator/inspect/work-card.ts`
- `packages/brewva-tools/src/families/memory/attention-options.ts`
- `packages/brewva-gateway/src/extensions/api.ts`
- `packages/brewva-gateway/src/hosted/internal/turn/runtime-turn-verification-gates.ts`
- `packages/brewva-std/src/async.ts`
- `packages/brewva-gateway/src/hosted/internal/turn/turn-envelope.ts`
- `packages/brewva-gateway/src/channels/effect-serial-queue.ts`
- `packages/brewva-effect/src/index.ts`
- `packages/brewva-effect/src/schedules.ts`
- runtime turn execution: `packages/brewva-runtime/src/runtime/turn/impl.ts`
- `packages/brewva-provider-core/src/stream/run-provider-stream.ts`
- `packages/brewva-tools/src/families/execution/exec-process-registry/service.ts`

## Related Docs

- `docs/architecture/design-axioms.md`
- `docs/architecture/system-architecture.md`
- `docs/reference/events/README.md`
- `docs/reference/runtime.md`
