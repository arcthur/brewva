# RFC: Accountable Tool-Schema Cost And The Deferred Definition-Side Compression Trigger

## Metadata

- Status: active
- Implementation state: Phase 1 (observability) landed against a green typecheck
  and targeted gateway unit suites; Phase 2 remains gated on the Phase 1
  measurement. This note re-opens a previously deferred decision rather than
  proposing a net-new capability.
- Owner: Runtime, gateway, and provider-core maintainers
- Last reviewed: `2026-06-26`
- Depends on:
  - [Decision: Capability Compression And Output Distillation](../decisions/capability-compression-and-output-distillation.md)
    (the standing deferral this note re-opens)
  - [Decision: Model-Operated Working Memory And Context Governance Reset](../decisions/model-operated-working-memory-and-context-governance-reset.md)
    (the `Model owns attention` line that constrains any re-opening)
  - [Decision: Cost Observability And Budget Governance](../decisions/cost-observability-and-budget-governance.md)
    (cost surfaces must not widen tool authority or routing)
  - [Decision: Managed Tool Capability Single-Sourcing](../decisions/managed-tool-capability-single-sourcing.md)
  - [RFC: Reversible References, Advisory Compression Routing, And Replay-Distilled Precedent](./rfc-reversible-references-advisory-compression-and-replay-distilled-precedent.md)
- Promotion target:
  - `docs/reference/token-cache.md`
  - `docs/reference/budget-matrix.md`
  - `docs/reference/runtime.md`
  - `docs/reference/tools.md`
  - `docs/architecture/cognitive-product-architecture.md`

## Problem Statement

A peer agent runtime (`maka`) treats the tool schema advertised to a provider as
a first-class, provider-visible cost surface: it ships only a light default set
and lets the model pull heavier tool groups on demand through an explicit
`load_tools` group-activation call, recording each load on its ledger and
reseeding the active set next turn. Its cost design states the principle
directly: a tool runs locally, but its **schema is paid for on every request it
is advertised in**, and it is part of the durable provider prefix.

Brewva advertises tools differently. The provider-visible set is derived from
**capability selection** (workspace/agent scope and permission policy), not from
any cost economy. Every tool that survives capability selection contributes its
schema to the durable prefix and to `toolSchemaSnapshot`/`perToolHashes` in the
provider request fingerprint, every turn, regardless of whether the session will
use it. There is no model-invoked mechanism to keep the initial advertised set
small and expand it on explicit demand, and there is no accounting that tells an
operator how many tokens the advertised schema costs or attributes a cache break
to a deliberate schema-set change versus an unexplained one.

Two facts make this a re-opening, not a discovery:

- Brewva already considered definition-side capability compression
  (`capability_search`/`capability_execute`) and **deliberately deferred it**
  (`capability-compression-and-output-distillation`, 2026-03-02) "until tool
  cardinality and routing quality justify the additional protocol and governance
  complexity."
- The subsequent constitutional decision
  (`model-operated-working-memory-and-context-governance-reset`, 2026-05-08)
  named `skill-load gates` as explicitly **not the default cognitive path**, and
  fixed the line `Model owns attention. Runtime owns physics.` Any runtime that
  silently hides tools the model might need would violate it.

So the open question is not "should brewva copy `load_tools`." It is: **has the
deferral trigger been met, and if it ever is, what is the only re-homing that
does not re-introduce a runtime attention gate?** This note answers the second
question precisely and turns the first into a measured, falsifiable gate instead
of a vibe.

## Scope Boundaries

In scope:

- **Tool-schema cost observability (Phase 1):** a per-turn estimate of the
  provider-visible tool-schema token cost, and attribution of tool-schema-set
  changes as a named, accounted cause inside the existing provider cache-break
  and context-evidence planes. No authority change.
- **A measured re-opening trigger (the gate):** the falsifiable condition, read
  from Phase 1 data, under which the deferred definition-side compression is
  re-opened.
- **The only admissible re-homing (Phase 2, gated):** if and only if the trigger
  fires, a model-invoked group-activation tool with tape-receipt reseed and an
  execute-boundary guard, plus the invariants that keep it permission-orthogonal
  and replay-deterministic.

Out of scope:

- a runtime/kernel transform that auto-hides, auto-routes, or auto-selects which
  tools are visible on the default turn path (rejected: re-introduces the
  attention gate the 2026-05-08 decision removed)
- changing capability selection, admission, or `MANAGED_BREWVA_TOOL_METADATA`
  single-sourcing as the authority over whether a tool **may run**
- letting cost signal widen tool authority, provider routing, or context
  admission (forbidden by `cost-observability-and-budget-governance`)
- per-turn semantic tool routing (rejected by both runtimes as prefix-thrashing
  and undiagnosable; `maka` DR-5, brewva model-attention line)
- output-side tool-result distillation (already stable and owned elsewhere)
- reversibility of dropped history spans (owned by the reversible-references RFC)

Out of scope but tracked for future work:

- a default-on economy posture per provider/workload (only after Phase 1 proves
  the cost is material and Phase 2 proves the expansion is behavior-safe)

## Why

### Why tool-schema cost is worth measuring now (Phase 1)

Brewva can already account cache reads/writes/misses and renders economic
verdicts over compaction (`buildCompactionEconomicVerdicts`:
`cache_regression`, `unaccounted_break`, `wasteful`). But the advertised
tool-schema set is a prefix component the fingerprint already hashes
(`toolSchemaSnapshot`, `perToolHashes`) without any operator-facing token
estimate or break attribution. When a session loads a skill or enters a new
scope and the tool set changes, the resulting provider cache break currently has
no first-class explanation — it can surface as an `unaccounted_break` it should
not own. Measuring schema cost and naming schema-set changes as an accounted
break cause is cheap, adds no authority, and is exactly the
`cost-observability-and-budget-governance` posture: an inspectable,
replay-derived runtime surface. This is the "先观测再启用 / Phase 1 conservative
default" discipline applied to its own blind spot.

### Why a direct `load_tools` port is the wrong design

`maka` installs schema economy on its `AiSdkBackend` via a `ToolAvailability`
runtime that owns which tool schemas are visible — a second authority over tool
visibility sitting next to permission. Porting that into brewva would create a
runtime-owned gate over what the model can see, which the 2026-05-08 decision
explicitly pushed off the default cognitive path, and would split "which tools
exist for the model" across capability selection and a new availability engine.
The lesson brewva already encoded is the opposite of `maka`'s: do not let the
runtime decide attention.

### Why a measured, model-invoked re-homing is the only admissible form

If the cost turns out to be material, the capability still has to live where
brewva keeps attention authority: with the model. The admissible shape is a
model-invoked group-activation tool (the model asks to load a tool group), with
the load recorded as a tape receipt and the active set reseeded deterministically
from the tape next turn — identical in spirit to how the reversible-references
RFC re-homed external compression as model-operated, tape-accountable effects.
Permission stays orthogonal: loading a group's schema is not a grant, and
admission still decides whether the tool may run. This is also `maka`'s own
conservative conclusion (DR-5: explicit group activation into the ledger, never
per-turn routing), so the two runtimes converge on the safe shape — brewva just
refuses to enable it before the cost is proven.

## Direction

1. **Measure before gating.** Phase 1 adds a provider-visible tool-schema token
   estimate and attributes schema-set changes as a named accounted cache-break
   cause, reusing the fingerprint and context-evidence planes. No tool is hidden;
   no authority moves.
2. **Gate the re-opening on data, not intuition.** Definition-side compression
   re-opens only if Phase 1 shows the advertised schema is a material, recurring
   cost driver (concrete threshold in the gate below). Otherwise this note is
   archived with the measurement as its result, and the 2026-03-02 deferral
   stands — a legitimate, falsifiable outcome.
3. **If re-opened, the model operates it.** Phase 2 is a model-invoked
   group-activation tool with tape-receipt reseed and an execute-boundary guard,
   never a runtime auto-hide. Permission and admission are untouched.
4. **Observability stays power-neutral.** Cost signal informs operators and the
   model; it never widens tool authority, routing, or admission
   (`cost-observability-and-budget-governance`).

## Architectural Positions

- **Visibility is not permission.** Capability selection and
  `tool-admission-policy` remain the only authority over whether a tool may run.
  Any future schema economy governs only whether a schema is **advertised** this
  step. Loading a group never grants capability; an unloaded group's tool is
  rejected at the execute boundary, fail-closed and inspectable, before
  admission.
- **No second tool registry.** The full dispatch set is the existing capability
  registry (`MANAGED_BREWVA_TOOL_METADATA`, single-sourced). The advertised set
  is a deterministic projection over it, not a parallel store.
- **Tape owns the loaded-group fact.** Group-load events are tape receipts; the
  advertised set rebuilds deterministically on replay and restart. No hidden host
  state, consistent with the projection discipline shared by active notes.
- **Conservative and model-owned, never per-turn routing.** The runtime never
  auto-selects which tools to hide or show on the default path. This is the one
  point both runtimes already agree on.
- **Observability reuses existing planes.** Phase 1 adds to the fingerprint and
  `context-evidence` cache-observation surface (`changedFields`,
  economic verdicts) plus the cost view; it introduces no new telemetry plane and
  no new authority.

## Source Anchors

Stable docs and decisions:
`docs/research/decisions/capability-compression-and-output-distillation.md`,
`docs/research/decisions/model-operated-working-memory-and-context-governance-reset.md`,
`docs/research/decisions/cost-observability-and-budget-governance.md`,
`docs/research/decisions/managed-tool-capability-single-sourcing.md`,
`docs/architecture/design-axioms.md`,
`docs/reference/token-cache.md`,
`docs/reference/budget-matrix.md`,
`docs/reference/tools.md`.

Internal implementation anchors:

- Phase 1 (landed):
  `packages/brewva-gateway/src/hosted/internal/provider/cache/break-detector.ts`
  (`classifyUnexpectedBreakReason`, `tool_schema_set_changed`),
  `packages/brewva-gateway/src/hosted/internal/session/managed-agent/provider-payload-pipeline.ts`
  (assembly-time estimate),
  `packages/brewva-gateway/src/hosted/internal/session/managed-agent/session-contracts.ts`
  (`ProviderCacheRuntimeState.lastToolSchemaEstimatedTokens`),
  `packages/brewva-gateway/src/hosted/internal/session/managed-agent/provider-assistant-observer.ts`,
  `packages/brewva-gateway/src/hosted/internal/context/materialization.ts`
  (`observeHostedProviderCache`),
  `packages/brewva-gateway/src/hosted/internal/context/evidence/context-evidence/store.ts`,
  `packages/brewva-gateway/src/hosted/internal/context/evidence/context-evidence/types.ts`,
  `packages/brewva-gateway/src/hosted/internal/context/evidence/context-evidence.ts`,
  `packages/brewva-gateway/src/hosted/internal/provider/cache/fingerprint.ts`
  (`toolSchemaSnapshot`, `perToolHashes`).
- Phase 2 (gated, not built):
  `packages/brewva-gateway/src/hosted/internal/context/capability-view.ts`
  (`activeToolNames`, `visible`),
  `packages/brewva-gateway/src/hosted/internal/session/tools/capability-selection.ts`,
  `packages/brewva-gateway/src/hosted/internal/session/tools/capability-registry.ts`,
  `packages/brewva-runtime/src/runtime/kernel/policy/tool-admission-policy.ts`,
  `packages/brewva-tools/src/registry/managed-metadata.ts`.

External comparison anchors:
`/Users/bytedance/new_py/maka-agent/docs/deepseek-reasonix-cost-runtime-design.md`
(sections 13 and DR-5, tool schema economy),
`/Users/bytedance/new_py/maka-agent/packages/runtime/src/tool-availability.ts`,
`/Users/bytedance/new_py/maka-agent/packages/runtime/src/ai-sdk-backend.ts`.

## Architecture Proposal

### Phase 1: Tool-schema cost observability (no authority change)

- Compute a per-turn provider-visible tool-schema token estimate from the same
  serialized tools the fingerprint snapshots (`toolSchemaSnapshot.tools`) at
  request assembly, and carry it on the existing per-turn provider cache
  observation into the **context-evidence** session report
  (`latestToolSchemaEstimatedTokens`) and aggregate report
  (`sessionsWithToolSchemaEstimate`, `totalLatestToolSchemaEstimatedTokens`) —
  the cost-shape diagnostics plane that already carries `providerInputTokens`,
  not the `SessionCostSummary` budget plane. Fidelity caveat: the estimate tracks
  the pinned base tool set the snapshot hash is paired with, so same-name
  description drift (which moves only `toolSchemaOverlayHash`) is not reflected
  until the tool name-set changes; this keeps the estimate aligned with
  `toolSchemaSnapshotHash` rather than the live overlay text.
- Add a named cache-break cause, `tool_schema_set_changed`, in `break-detector`'s
  unexpected-break classifier. It fires only when the changed fingerprint fields
  are **exclusively** tool-schema fields (`toolSchemaSnapshotHash`,
  `toolSchemaOverlayHash`, `tool:*`) plus per-turn request noise (`requestHash`,
  `dynamicTailHash`); any other durable prefix field changing keeps the generic
  reason. This under-attributes rather than mis-attributes, and surfaces the
  break as an **accounted** entry in `providerCacheBreakReasonCounts` instead of
  the generic `cache_read_drop_exceeded_threshold`.
- Together these surface, per session, the tool-schema token estimate and how
  often a schema-set change broke the prefix cache. This is the gate's evidence.

### The gate (read from Phase 1 data)

Re-open definition-side compression only if, over a representative corpus:

- advertised tool-schema tokens are a material share of durable-prefix input
  tokens (proposed threshold to ratify during review, e.g. schema >= 15% of
  prefix input on long sessions), **and**
- schema-set changes are a recurring, attributable cache-break cause rather than
  a rare one.

If either fails, archive this note with the measurement as its result; the
2026-03-02 deferral stands.

### Phase 2 (gated): model-invoked group activation

Only if the gate fires:

- Define tool **groups** as registry metadata over the single-sourced
  `MANAGED_BREWVA_TOOL_METADATA` (heavy families grouped; light tools ungrouped
  and default-visible). No parallel store.
- Advertised set = `capabilitySelection ∩ (defaultVisible ∪ loadedGroups)`, where
  `loadedGroups` is reseeded from tape receipts each turn — a deterministic
  projection.
- Add a model-invoked `capability_expand({ group })` tool (or fold into an
  existing capability verb if surface review prefers) that emits a tape receipt;
  the group's schemas enter the advertised set from the next step.
- Execute-boundary guard: a tool whose group is not in the step-start advertised
  set is rejected by availability before admission, fail-closed and inspectable —
  loading a group in the same step does not retroactively make its tools callable
  that step.
- Permission orthogonality: admission and capability selection are unchanged;
  expansion changes advertisement only.

## How To Implement

### Phase 0: Boundary confirmation

- Confirm the fingerprint's `toolSchemaSnapshot` serialization is a stable basis
  for a token estimate and a `tool_schema_set_changed` delta.
- Confirm `context-evidence` can carry the estimate and an accounted break cause
  without widening authority.

### Phase 1: Observability (low risk, do now) — LANDED

Implemented entirely inside the gateway provider-cache-observation /
context-evidence plane (no vocabulary contract change, no authority change):

- Estimate computed at assembly in `provider-payload-pipeline` via
  `estimateStructuredTokenCount(toolSchemaSnapshot.tools, …)`, stored on
  `ProviderCacheRuntimeState.lastToolSchemaEstimatedTokens`, threaded through the
  assistant observer and `observeHostedProviderCache` onto
  `ProviderCacheObservationEvidenceSample.toolSchemaEstimatedTokens`, and
  aggregated by `buildContextEvidenceReport`.
- `tool_schema_set_changed` added to `break-detector`'s
  `classifyUnexpectedBreakReason`, exclusivity-gated as described above; it flows
  through the existing `reason` field into `providerCacheBreakReasonCounts`.
- Tests: `provider-cache-fingerprint.unit.test.ts` (positive attribution +
  non-schema-co-change fall-back) and `context-evidence-report.unit.test.ts`
  (latest estimate, aggregate counters, legacy-sample default to 0).
- Verified: full typecheck clean; targeted gateway unit suites green; observability
  only — no consumer reads the reason or the estimate for any gate, routing, or
  admission decision.

### Phase 2: Model-invoked group activation (only if the gate fires)

- Add group metadata to the registry; derive the advertised-set projection;
  reseed `loadedGroups` from tape.
- Add `capability_expand` and the execute-boundary guard.
- Fitness: advertised set is a deterministic projection across replay; loading a
  group is not a permission grant (admission still gates); a same-step unloaded
  tool call is rejected fail-closed; loaded groups reseed from tape after restart;
  the default path advertises no auto-hidden tool unless economy posture is
  explicitly opted in.

## Validation Signals

Required tests and checks:

- Phase 1 attribution fitness: a tool-schema-set change is recorded as
  `tool_schema_set_changed` and excluded from `unaccounted_break`.
- Phase 1 determinism fitness: the schema token estimate and break attribution
  are stable across replay and index rebuild.
- Phase 1 power-neutrality fitness: adding the cost surface changes no tool
  authority, provider routing, or admission decision.
- Phase 2 projection fitness: advertised set rebuilds deterministically from
  capability selection plus tape-reseeded loaded groups.
- Phase 2 permission-orthogonality fitness: group load is not a capability grant;
  admission verdicts are unchanged by advertisement.
- Phase 2 execute-boundary fitness: a same-step unloaded tool call fails closed
  to an inspectable blocked posture and never reaches the tool implementation.
- Phase 2 default-path fitness: with economy posture off, no tool is hidden.
- docs verification with `bun run test:docs`.
- Markdown formatting check with `bun run format:docs:check`.

Promotion should also require an inspect artifact showing per-session
tool-schema token share and at least one attributed `tool_schema_set_changed`
break, plus (if Phase 2 ships) one trace of a model-invoked group load reseeding
across a turn boundary.

## Surface Budget

_Counts are net additions introduced by this RFC. Phase 1 rows are unconditional;
Phase 2 rows are conditional on the gate firing and are marked `(P2, gated)`._

| Surface                               | Before | After | Notes                                                                                               |
| ------------------------------------- | -----: | ----: | --------------------------------------------------------------------------------------------------- |
| Required authored fields              |      0 |     0 | No new required user configuration.                                                                 |
| Optional authored fields              |      0 |     1 | `(P2, gated)` an opt-in economy posture; absent in Phase 1.                                         |
| Author-facing concepts                |      0 |     1 | `(P2, gated)` tool group / definition-side schema economy. Phase 1 adds none (cost is established). |
| Inspect surfaces                      |      0 |     0 | Phase 1 reuses `cost_view`/obs-snapshot and the existing cache-observation surface.                 |
| Routing/control-plane decision points |      0 |     1 | `(P2, gated)` the advertised-set projection gate. Phase 1 adds none.                                |
| Public tools                          |      0 |     1 | `(P2, gated)` `capability_expand`; could fold into an existing capability verb.                     |

Positive surface delta (Phase 2 only, conditional):

- Debt owner: runtime, gateway, and provider-core maintainers.
- Why unavoidable: a model-invoked expansion needs one tool, one author-facing
  concept, and one projection decision point; the budget is held to the minimum
  by reusing the single-sourced registry, tape receipts, and the existing
  capability-view projection instead of adding an availability engine or a second
  store. Phase 1 carries zero net required surface.
- Dated re-evaluation trigger: by `2026-09-30`, evaluate Phase 1 measurements
  against the gate. If the gate has not fired, archive this note and keep the
  2026-03-02 deferral; do not spend any Phase 2 surface.

## Promotion Criteria

Move this note to `docs/research/decisions/` only after:

- Phase 1 ships with attribution, determinism, and power-neutrality fitness, and
  stable docs (`token-cache.md`, `budget-matrix.md`) carry the tool-schema cost
  surface.
- The gate is evaluated against real measurements and the outcome (re-open or
  keep deferred) is recorded.
- If Phase 2 ships: advertised-set projection, permission orthogonality,
  execute-boundary fail-closed, tape reseed, and default-path-off behavior all
  hold under fitness, and stable docs carry the contract; the 2026-03-02
  deferral decision gains a `Superseded by` link to this note's decision.
- Source anchors either move into stable docs or decision records.

## Open Questions

- What exact thresholds ratify the gate (schema share of prefix input; break
  recurrence rate), and over what corpus?
- Should `capability_expand` be a new verb or a mode of an existing capability
  tool, to hold the surface budget?
- What is the right group granularity (per family, per heavy-family) so loads are
  rare enough not to thrash the prefix?
- How does group activation interact with capability selection when a scope change
  already alters the advertised set in the same turn?
