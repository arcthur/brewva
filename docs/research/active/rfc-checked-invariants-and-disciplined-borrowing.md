# RFC: Checked Invariants And Disciplined Peer Borrowing

## Metadata

- Status: active
- Implementation state: in progress on this branch. Phase 1 landed: H (dead
  placeholder removed); E (coarse-bucket lifecycle phases via
  `HOSTED_LIFECYCLE_PHASES` and phase-grouped `registerTurnLifecyclePorts`,
  behavior unchanged under the regression suite); and F's two Phase-1 fitness —
  the no-context-write allowlist (a `RUNTIME_PLUGIN_CAPABILITY_EFFECTS`
  single-source effect map from which `RuntimePluginCapability` and the inventory
  derive) and the capability-set drift guard (`HOSTED_BEHAVIOR_CAPABILITIES`
  mirrored by a named block in the journey doc, checked both ways). Also landed:
  G2 — the hosted provider request is a HYBRID (dispatch baseline plus
  `materialize()` delta plus an out-of-projection systemPrompt), now stated in
  `runtime.md` and pinned by a boundary-guard fitness; F's Phase-2
  `capability x plugin` matrix as a generated authority inventory
  (`docs/reference/host-plugin-capabilities.md`), pinned by a regenerate-and-diff
  freshness fitness; and C — the tool-identity guard — where the executor snapshots
  each tool's session-scoped identity (the registered surface is session-stable) and
  fails closed on a same-name drift; and A —
  opencode's diff algebra (`diffKeyedBlocks`) applied to the reachable dynamic-tail
  blocks as structured per-block stability evidence (the systemPrompt prefix stays
  scoped until `getBaseSystemPrompt` exposes a document). Borrowing item D is
  dropped as redundant (brewva already has `renderCall` / `renderResult`); and G1
  is dropped as redundant too — brewva already tapes the full provider-request
  digest via `recordRuntimeHarnessManifest` (`requestHash` plus systemPrompt and
  per-message hashes). Every RFC item is now landed or resolved.
- Owner: Runtime, substrate, gateway, and tools maintainers
- Last reviewed: `2026-06-21`
- Depends on:
  - [Decision: Managed Tool Capability Proof](../decisions/managed-tool-capability-proof.md)
  - [Decision: Turn Lifecycle Spine](../decisions/turn-lifecycle-spine.md)
  - [Decision: Hosted Materialization Plan](../decisions/hosted-materialization-plan.md)
  - [Decision: Model Interface Attention Contract](../decisions/model-interface-attention-contract.md)
  - [Decision: Prefix-Stable Context Management And Progressive Compaction](../decisions/prefix-stable-context-management-and-progressive-compaction.md)
  - [Decision: Provider-Core Domain Slicing And Driver Port Boundaries](../decisions/provider-core-domain-slicing-and-driver-port-boundaries.md)
  - [Axiom Negative-Space Linkage And Decisions Demotion](./axiom-negative-space-and-decisions-demotion.md)
  - [RFC: Attention As An Accountable Effect](./rfc-attention-as-an-accountable-effect.md)
- Promotion target:
  - `docs/architecture/design-axioms.md`
  - `docs/architecture/invariants-and-reliability.md`
  - `docs/journeys/internal/hosted-behavior-installation.md`
  - `docs/reference/runtime.md`
  - `docs/reference/extensions.md`

## Problem Statement

Brewva's distinctive value is entirely in its invariants. The separation of
durable tape truth from pure materialization, the per-operation fail-closed
capability gate, the deliberate absence of any context-source registry, and the
no-magic-default physics mode are what set it apart from peer agent runtimes.
Those invariants are implemented and described in prose. Several of the most
load-bearing ones are not yet anchored by a checked artifact: they survive only
because a human reads the code correctly each time it changes.

Verified gaps (file lines in Source Anchors):

- The hosted turn-lifecycle-port **order** is an inline array literal in
  `installHostedBehavior`. There is no named phase constant or typed phase tag,
  so the ordering contract — on which the whole spine's correctness depends —
  lives only in code position and prose. This is a different layer from the
  kernel **gate** spine order, which the turn-lifecycle-spine decision already
  fixes; the hosted lifecycle-port array is not covered there.
- The host-plugin capability enum has no generated `capability x plugin` matrix
  and no fitness asserting the two invariants that make it safe: that no
  `register-*-source` / provider-registry member exists, and that
  `hosted_behavior`'s declared set equals the set the journey doc documents.
  The capability is single-sourced and proven per tool, but the plugin-level
  authority inventory is not a checked artifact.
- The hosted provider request is a HYBRID, not `PromptPlan` alone, and the
  contract for that hybrid is only partly stated. `materialize()`
  (`runtime/turn/impl.ts`) supplies only the post-cursor committed tape delta; the
  baseline — restored history, the current user message, plugin transforms — comes
  from the rebuildable hosted session projection store (`buildSessionContext`, not
  `tape.replayBaseline`), and the environment-derived `systemPrompt` is set on
  hosted agent state outside the projection (`runtime-provider-context.ts` merges
  the two). Code comments and `runtime.md` already note the baseline-plus-delta
  shape, but nothing names the baseline's non-tape provenance, the systemPrompt's
  outside-projection nature, or the exact replay guarantee — so `PromptPlan` reads
  like the full provider truth when it is not.
- The tool-surface seam has no in-flight tool-identity guard: a `tool_call`
  whose advertised surface drifts between proposal and execution is not detected.
- `assertHostedBehaviorHostAdapterRuntimeShape` is an empty no-op placeholder.

Separately, two sibling runtimes (`opencode`, `pi-mono`) solve adjacent problems
with mechanisms brewva can adopt — but only if the mechanism is taken without the
authority shape that would break a brewva invariant.

This RFC does exactly two things: it upgrades the invariants above from
documented promises to checked artifacts, and it borrows two peer mechanisms into
the correct authority ring.

## The Governing Line

`A documented invariant that nothing checks is a promise, not a contract.`

This is general enough to stand as a candidate axiom 19, not merely a sub-point
of axiom 14 (documentation must not silently widen authority) and axiom 15
(public width compresses toward authority width). It reuses the same
derived-artifact and regenerate-and-diff discipline the axiom-negative-space note
already established for `axiom-enforcement.md`, and extends it from axioms to the
runtime's own structural invariants.

The borrowing half has its own line:

`Borrow the mechanism, never the authority shape.`

Take `opencode`'s snapshot diff algebra, not its context-source registry. Take
`pi-mono`'s call/result rendering ergonomics, into the advisory ring, not the
hosted lane.

## Scope Boundaries

In scope — Checked Invariants:

- **E.** A named lifecycle-phase constant / typed phase tag for the hosted
  turn-lifecycle-port array, so the order is a readable, tested invariant.
- **F.** A generated `capability x plugin` matrix artifact plus fitness
  asserting the no-context-source invariant and the `hosted_behavior`
  capability-set equality against the journey doc.
- **G.** An explicit `PromptPlan` replay-contract boundary: either tape a digest
  of the rendered `systemPrompt`, or declare that materialization guarantees
  conversation-data replay only and the environment-derived `systemPrompt` is
  re-rendered, never replayed.
- **C.** An in-flight tool-identity drift guard at the tool-surface seam.
- **H.** Removal of the obsolete `assertHostedBehaviorHostAdapterRuntimeShape`
  placeholder.

In scope — Disciplined Borrowing:

- **A.** An `opencode`-style typed snapshot `baseline/update/removed` diff
  algebra applied **internally** to materialization cache-prefix stability
  evidence — not a context-source registry.
- **D.** (resolved: dropped as redundant) `pi-mono`'s `renderCall` / `renderResult`
  tool-display ergonomics would have gone into the **advisory ring**, but brewva
  already has them on `BrewvaToolDefinition` — see Part 2.

Out of scope (owned elsewhere; referenced, not rebuilt):

- Provider route / protocol / transport layering — decided by the provider-core
  domain-slicing decision and shipped at this branch's base. Referenced only.
- Naming the aesthetic / creed — `design-axioms.md` carries the constitutional
  line and the attention RFC already named `Model-sovereign, tape-accountable
context`. This RFC adds the enforcement line, not a second name.
- The kernel **gate** spine order (`ingress_received -> ... ->
terminal_recorded`) — decided by the turn-lifecycle-spine decision. Item E is
  the hosted lifecycle-**port** array, a distinct layer.
- Re-introducing any context-source registry, provider registry, or
  prompt-injection admission path — forbidden by the no-context-source invariant
  (axiom 18; system-architecture's "no default context-source admission path").
- Multi-agent capability delegation — the stable boundary stays `single tool
call` (axiom 17).
- Surface amplification (constitution distribution, Work Card default, Context
  Runway, two-tier lexicon lint) — owned by the attention RFC's Phase 5. Not
  duplicated here.

Out of scope but tracked for future:

- Whether G's boundary should extend to **all** environment-derived
  system-prompt blocks (custom instructions, tool policy, environment), not only
  project instructions.
- Whether the F matrix should also cover the opt-in advisory extension ring's
  ambient capability class, not only internal plugins.

## Why

Two arguments, one defensive and one acquisitive.

**Invariants corrode unless checked.** Every brewva invariant that lives only in
prose degrades on contact with normal change. Anyone can append a port to the
lifecycle array and silently reorder a slot. Anyone can add a capability enum
member and quietly open a context-write path that is not a message edit. Anyone
reading `PromptPlan` will assume it is the full provider truth, because nothing
says otherwise — and will be wrong at the `systemPrompt` overlay. Turning these
into checked artifacts is the only form in which the aesthetic survives time. It
is axiom 14 and 15 made executable.

**Borrow without importing the failure mode.** The comparison is instructive
precisely because the peer solves the adjacent problem with the authority shape
brewva rejects:

- `opencode` has an elegant System Context source algebra
  (`baseline/update/removed`) — wrapped in an **open source registry**. The
  algebra is worth taking for materialization cache stability; the registry
  would reintroduce the exact context-source admission path brewva deleted.
- `opencode`'s tool registry guards against in-flight identity drift; brewva has
  no equivalent guard and should add one (item C).
- `pi-mono`'s `renderCall` / `renderResult` are good product ergonomics — living
  in an **unbounded extension** with full process access. The ergonomics belong
  in brewva's advisory ring (model-bypassable, authority-free), not the hosted
  lane.

Brewva's promise is autonomy with receipts and authority with boundaries. This
RFC keeps both promises checkable instead of merely stated.

## Architectural Positions

- **Checked beats documented.** A structural invariant that a fitness test does
  not enforce is negative space, not a contract (axiom 14, 15). F and E convert
  the two highest-risk prose invariants into regenerate-and-diff artifacts, the
  same pattern the axiom-negative-space note uses for `axiom-enforcement.md`.
- **No second context-source authority — by allowlist, not denylist.** The only
  context-write path is a message-list edit gated by `context_messages.write`
  (axiom 18). The guard must assert this positively — the set of capabilities
  whose effect class is context-write equals exactly `{context_messages.write}`
  — not by banning `*source*`/`register*` name substrings, which both
  false-positive on `tool_registration.write` and would miss a hypothetical
  `context_provider.write`. A name denylist is precisely the "checked nothing"
  this RFC warns against.
- **A borrowed mechanism lands in the ring that already owns the decision**
  (axiom 11; the Ring Model). The snapshot diff algebra (A) is
  Runtime-Physics-class cache evidence, never a context source. The rendering
  ergonomics (D) are Experience/advisory-ring views that grant no authority.
  Neither touches the kernel or the four-port runtime root.
- **A replay contract must be explicit, not inferred** (axiom 5; axiom 16).
  Because the hosted lane assembles its provider call on a path parallel to
  `materialize()`, the contract to fix is not "PromptPlan minus a systemPrompt"
  but "which projection is authoritative, and how hosted dispatch converges on or
  declares divergence from it" (AGENTS.md already targets convergence on
  `runtime.turn`). Both honest answers — make it a receipt, or declare the
  boundary — must first establish that scope.
- **Tool-surface identity is a correctness-bearing judgment** (axiom 16). If the
  advertised surface drifts between when a `tool_call` is proposed and when it
  executes, the executed semantics differ from the approved semantics — a replay
  and approval correctness problem, so the guard belongs at the gate, not in a
  comment.
- **Delete the placeholder that earns nothing** (axiom 3). An empty
  `void {}` validator is hidden cleverness pretending to be a safety check;
  subtraction is the honest move.

## Source Anchors

Stable docs and project rules:
`docs/architecture/design-axioms.md`,
`docs/architecture/invariants-and-reliability.md`,
`docs/architecture/system-architecture.md`,
`docs/journeys/internal/hosted-behavior-installation.md`,
`docs/reference/runtime.md`,
`docs/reference/extensions.md`.

Internal implementation anchors (verified current-state):

- `packages/brewva-gateway/src/hosted/internal/session/host-api-installation.ts`
  (empty `assertHostedBehaviorHostAdapterRuntimeShape` placeholder; the inline
  `registerTurnLifecyclePorts([...])` array; the `hosted_behavior` capability
  set)
- `packages/brewva-substrate/src/host-api/plugin.ts` (`RuntimePluginCapability`
  enum; no `register-*-source` member)
- `packages/brewva-substrate/src/host-api/plugin-runner.ts` (`assertCapability`
  fail-closed enforcement)
- `packages/brewva-runtime/src/runtime/runtime-api.ts` (the four ports: `tape`,
  `kernel`, `model`, `turn`)
- `packages/brewva-runtime/src/runtime/model/port.ts` (`PromptPlan`,
  `messageSourceEventIds`, `ModelPort.materialize` / `proposeCheckpoint`)
- `packages/brewva-runtime/src/runtime/model/impl.ts` (`materialize` projects
  only `replayBaseline` events; no `systemPrompt` overlay)
- `packages/brewva-gateway/src/hosted/internal/session/managed-agent/session-prompt-dispatch.ts`
  (`appendTargetScopedProjectInstructions` reads project-instruction files;
  `applyPromptOverlay` applies the assembled `systemPrompt` outside the
  projection)
- `packages/brewva-gateway/src/hosted/internal/session/tools/tool-surface.ts`
  (no in-flight tool-identity guard)

External comparison anchors (contrasts and borrow targets in sibling repos, not
brewva paths):

- `/Users/bytedance/new_py/opencode/packages/opencode/src/system-context/registry.ts`
  (the `baseline/update/removed` algebra to borrow; the open registry to reject)
- `/Users/bytedance/new_py/opencode` tool registry identity check (the in-flight
  drift guard to borrow as item C)
- `/Users/bytedance/new_py/pi-mono/packages/coding-agent`
  (`renderCall` / `renderResult` ergonomics to port into the advisory ring;
  unbounded extension authority to reject)

## Architecture Proposal

### Part 1 — Checked Invariants

#### E. Named lifecycle phases (coarse buckets)

The hosted lifecycle-port array is built inline. Introduce coarse, ordered phase
buckets — `pre_model` / `model_io` / `post_tool` / `teardown` — and assemble the
array from them, rather than a unique tag per port. Coarse buckets pin the order
without ossifying the spine (directly answering this RFC's own ossification
risk), and they correctly express the verified fact that the SAME module
legitimately spans more than one phase: `contextTransform` and `toolSurface` each
hold two non-adjacent slots today. A per-port unique tag would instead hide that.
A fitness test asserts the bucket order and that every port declares its bucket.
This is descriptive structure over the existing array, not a new dispatcher —
runtime behavior is unchanged.

#### F. Capability x plugin matrix + invariant fitness

All three parts have landed. The generated `capability x plugin` matrix lives at
`docs/reference/host-plugin-capabilities.md` (one row per capability: effect class
plus which internal plugins declare it), produced by
`script/generate-host-plugin-capability-matrix.ts` from the same single sources —
`RUNTIME_PLUGIN_CAPABILITY_EFFECTS` and `HOSTED_BEHAVIOR_CAPABILITIES` — and pinned
by a regenerate-and-diff freshness fitness with ground-truth anchors, the same way
`axiom-enforcement.md` is generated. The two targeted invariant tests on top:

- **No-context-source, by allowlist.** Tag each `RuntimePluginCapability` member
  with an effect class, and assert that the members whose effect class is
  context-write equal exactly `{context_messages.write}`. Do NOT ban
  `*source*` / `register*` substrings: that denylist false-positives on
  `tool_registration.write` and would still let a `context_provider.write` slip
  through. The positive allowlist is the semantic invariant; the name denylist is
  the "checked nothing" this RFC exists to stop.
- **Capability-set drift guard (not minimality).** Assert that
  `hosted_behavior`'s declared set equals the set the journey doc documents, read
  from one single source (consistent with the capability single-sourcing
  decision). This catches doc/code drift; it does NOT prove the set is minimal or
  correct — the RFC claims only the former.

Authority placement: matrix generation and fitness live in the docs/fitness
layer; no runtime change, no new capability.

#### G. Explicit PromptPlan replay contract — landed (G2)

Phase 0 path trace, resolved: the hosted provider request is a HYBRID.
`materialize()` (`runtime/turn/impl.ts`) supplies only the post-cursor committed
tape delta; `runtime-provider-context.ts` merges it onto a baseline that comes
from the rebuildable hosted session projection store (`buildSessionContext`, not
`tape.replayBaseline`), and the environment-derived `systemPrompt` is set on
hosted agent state outside the projection. So `PromptPlan` is the runtime.turn
projection, not the full provider truth.

G2 (declared boundary) is the chosen, landed direction. `runtime.md` now states
the hybrid shape, the baseline's non-tape provenance, the systemPrompt's
outside-projection nature, and the replay guarantee: committed tape events replay
exactly; the baseline projection and the systemPrompt are re-rendered from the
current store and environment. A guard fitness
(`hosted-materialize-boundary.fitness.test.ts`) pins the boundary so a future
change cannot fold the environment systemPrompt into the pure projection.

G1 (a hash-only digest of the full rendered provider request on tape, for
byte-exact "what the model saw" audit) is REDUNDANT and dropped: brewva already
records it. `createProviderRequestFingerprint` produces a `requestHash` plus
`stablePrefixHash` / `dynamicTailHash`, and `buildHarnessManifest` carries the
provider request's `systemPromptHash`, per-message `blockHashes`, tool-surface
hash, and runtime-config hash — persisted to tape by `recordRuntimeHarnessManifest`
(`provider-payload-pipeline.ts`). That is exactly G1's byte-exact audit; there is
nothing to build.

#### C. In-flight tool-identity guard — landed (fail-closed)

Reachability trace resolved it as real: tool execution re-read the live set —
`runtime-turn-tool-executor.ts` resolved `commitment.call.toolName` against the
current `getRegisteredTools()`, not a proposal-time snapshot — while
`setActiveTools` / `refreshTools` are exposed on `runner.actions`, so a mid-turn
surface change could make a `tool_call` run a different tool than the one the model
was offered.

Landed: the executor snapshots each registered tool's identity (its parameters
schema) once when it is built — the registered surface is session-stable
(`refreshTools` rebuilds the index without changing identity; `setActiveTools` only
narrows the visible subset), so that snapshot is the identity the model was offered.
At execution it compares the resolved tool's live identity against the snapshot; a
drift throws `hosted_runtime_tool_identity_drift:<tool>` — fail-closed, in brewva's
capability-gate style (axiom 16: tool-surface identity is correctness-bearing). With
no drift, behavior is unchanged (the regression suite is green); a same-name schema
drift is caught instead of silently running the drifted tool, and a name registered
later is allowed. If the registered surface ever becomes per-turn dynamic, the
snapshot moves to turn scope.

#### H. Remove the dead placeholder

Delete `assertHostedBehaviorHostAdapterRuntimeShape` (or replace its body with a
real shape assertion if one is actually wanted). An empty validator is worse than
no validator: it reads as a guarantee that does not exist.

### Part 2 — Disciplined Borrowing

#### A. Snapshot diff algebra for materialization cache stability — landed (tail blocks; prefix scoped)

Increment confirmed and landed: brewva's prefix-stability evidence recorded
`stablePrefixHash` plus a BOOLEAN `stablePrefix` — "did it change?", not "what
changed". `opencode`'s `baseline/update/removed` triple is now a reusable pure
helper, `diffKeyedBlocks` in `prompt-stability.ts`, reporting added / updated /
removed keyed blocks instead of a boolean.

Applied where blocks are actually reachable: the dynamic-tail blocks
(`HostedContextRenderResult.blocks`, each an id + content).
`buildPromptStabilityObservation` now hashes them per block, and
`recordPromptStability` runs `diffKeyedBlocks` to record `tailBlockHashes` and a
`changedTailBlocks` set on the prompt-stability evidence — so tail instability says
which block moved. It is additive: with no tail blocks the evidence is unchanged.

The cache-PREFIX (systemPrompt) blocks stay scoped: the hosted systemPrompt is an
opaque string the whole way (`getBaseSystemPrompt(): string`), so a per-prefix-block
diff needs that to expose its `BrewvaSystemPromptDocument` rather than a rendered
string. When it does, the same `diffKeyedBlocks` helper applies unchanged. Only the
algebra was taken, never the source registry: there is still no context-source
admission path, and the only context-write capability remains
`context_messages.write`.

#### D. Tool-display ergonomics into the advisory ring — redundant, dropped

Increment check, resolved: REDUNDANT. Brewva already has the exact mechanism —
`renderCall` / `renderResult` hooks on `BrewvaToolDefinition`, wired into the CLI
tool-render layer, the gateway advisory display (`resolveToolDisplay`), and HTML
export — with signatures essentially identical to `pi-mono`'s (`args`, `theme`,
`context`, and a full result object). Pi's hooks are the same names and intent,
already present in brewva. Borrowing adds no expressiveness, so D is dropped, not
pending: there is nothing to port.

## How To Implement

### Phase 0: Boundary Confirmation

- **Trace the hosted-vs-`materialize` path (blocks G).** Establish whether the
  hosted provider call should be `materialize()`'s projection or a parallel one,
  and how `buildSessionContext` / overlay / `emitContext` relate to `PromptPlan`.
  No G direction (G1 or G2) may be written into `runtime.md` before this is
  answered.
- **Confirm C's in-turn reachability** (the MCP `tools/list_changed` mid-turn
  path) before building it; otherwise defer C.
- E uses coarse buckets (`pre_model` / `model_io` / `post_tool` / `teardown`),
  descriptive over the current array, not a new dispatcher.

### Phase 1: P0 anti-corrosion (cheapest, highest leverage)

- E coarse-bucket phases; F's two invariant fitness tests (context-write
  allowlist `== {context_messages.write}`; capability-set drift guard). No runtime
  behavior change. Fitness: bucket order asserted; capability invariants guarded.
- **H lands independently, now.** Removing the empty
  `assertHostedBehaviorHostAdapterRuntimeShape` depends on nothing else and need
  not wait for the Phase 1 batch — ship it as a standalone cleanup.

### Phase 2: Capability matrix artifact

- F's generated `capability x plugin` matrix with regenerate-and-diff fitness,
  mirroring `axiom-enforcement.md`.

### Phase 3: PromptPlan replay contract (crown-jewel completion)

- Implement the chosen G direction; pin it with fitness; if G1, the digest is a
  hash-only redacted receipt; if G2, `runtime.md` carries the explicit boundary.

### Phase 4: In-flight tool-identity guard

- C at the tool-surface seam: advisory drift evidence first, fail-closed reject
  second, scoped to one accepted turn.

### Phase 5: Borrowing (resolved)

- A landed: the `diffKeyedBlocks` algebra feeds per-block dynamic-tail stability
  evidence (the systemPrompt prefix stays scoped). D dropped: brewva already has
  `renderCall` / `renderResult` on `BrewvaToolDefinition`, so there was nothing to
  port — borrowing without an increment is exactly the redundancy this RFC avoids.

## Validation Signals

- lifecycle-phase fitness: the port array is assembled from named phase tags;
  the phase order is asserted; every port declares its phase.
- no-context-source fitness (allowlist): the `RuntimePluginCapability` members
  whose effect class is context-write equal exactly `{context_messages.write}`;
  the test is a positive allowlist over effect-tagged members, never a
  `*source*` / `register*` name denylist.
- capability-set drift fitness: `hosted_behavior`'s declared set equals the
  documented set, read from one source (regenerate-and-diff). Guards drift, not
  minimality.
- capability-matrix fitness: the generated `capability x plugin` matrix matches
  code.
- promptplan-contract fitness (after the Phase 0 path trace): G1 — a redacted
  digest of the full rendered provider request (messages + `systemPrompt`)
  appears on tape and replay reproduces it; G2 — `runtime.md` documents exactly
  what `materialize()` guarantees versus what the hosted lane re-renders, with a
  test pinning that the hosted assembly path is the documented one.
- tool-identity fitness: a `tool_call` whose surface identity drifted between
  proposal and execution is rejected or flagged, never silently executed.
- dead-code fitness: `assertHostedBehaviorHostAdapterRuntimeShape` is removed or
  carries a real assertion.
- docs verification with `bun run test:docs`; formatting with
  `bun run format:docs:check`.

## Surface Budget

_Counts are net additions introduced by this RFC (`before = 0`)._

| Surface                               | Before | After | Notes                                                                                                  |
| ------------------------------------- | -----: | ----: | ------------------------------------------------------------------------------------------------------ |
| Required authored fields              |      0 |     0 | No new user configuration.                                                                             |
| Optional authored fields              |      0 |     0 | All items are internal invariants, checks, or advisory views.                                          |
| Author-facing concepts                |      0 |     0 | No new product lexicon; the enforcement line is authority-narrow taste in `design-axioms.md`.          |
| Persisted formats                     |      0 |   0-1 | Only if G1 is chosen: a hash-only `systemPrompt` digest receipt. G2 adds none.                         |
| Generated artifacts                   |      0 |     1 | The `capability x plugin` matrix, generated and diffed like `axiom-enforcement.md`.                    |
| Inspect surfaces                      |      0 |     0 | The PromptPlan inspect surface is named as a downstream possibility, not built here.                   |
| Public tools                          |      0 |     0 | No new tool.                                                                                           |
| Routing/control-plane decision points |      0 |     0 | C is a fail-closed correctness guard at an existing gate (like the capability gate), not a new branch. |

Positive surface delta:

- Debt owner: runtime, substrate, gateway, and tools maintainers.
- Why unavoidable: the matrix artifact and the optional G1 digest are the minimum
  durable surface needed to make the invariants checkable; everything else is
  fitness and internal structure that reduces, not grows, the documented-only
  surface.
- Dated re-evaluation trigger: by `2026-09-30`, before promotion, re-evaluate
  whether G1 or G2 shipped and whether A/D landed or should split into a surface
  RFC.

## Promotion Criteria

Move to `docs/research/decisions/` only after:

- E, F, and H land with green fitness; the no-context-source and
  capability-set-equality invariants are regression-guarded.
- G's Phase 0 path question is answered first (the hosted lane does not go
  through `materialize()` today); only then is a direction chosen, implemented,
  and pinned by fitness, and `runtime.md` carries the explicit
  hosted-vs-`materialize` replay-contract boundary.
- C lands with a fitness test, scoped to the single-tool-call boundary.
- Borrowing items are resolved: A landed (tail-block diff evidence), D dropped as
  redundant.
- `design-axioms.md` carries `A documented invariant that nothing checks is a
promise, not a contract` — general enough to stand as a candidate axiom 19, not
  a sub-point of axioms 14-15.
- Source anchors either move into stable docs or are recorded in the decision.

The borrowing half is resolved (A landed, D dropped as redundant) and was never a
promotion gate for the checked-invariant core.

## Open Questions

- A (prefix extension): the diff algebra is applied to dynamic-tail blocks today;
  extending it to the systemPrompt prefix needs `getBaseSystemPrompt` to expose its
  `BrewvaSystemPromptDocument` rather than a rendered string — worth doing when
  prefix cache-busting becomes a real diagnostic need.
- G (convergence): G2 declared the hosted-vs-`materialize` boundary; should the
  hosted lane eventually converge on `materialize()` (AGENTS.md's target), and on
  what timeline? A request digest (the old G1) is not needed —
  `recordRuntimeHarnessManifest` already tapes it.
- F (matrix scope): should the `capability x plugin` matrix include the advisory
  extension ring's ambient capability class, or stay internal-plugin-only?
- C (turn scope): C snapshots session-scoped because the registered surface is
  session-stable; if a future path makes it per-turn dynamic (e.g. an MCP
  `tools/list_changed` handler), the snapshot moves to turn scope.

## Alternatives Considered

- **Keep prose, change nothing.** Rejected: the invariants corrode (see Why);
  this is the failure mode the RFC exists to stop.
- **One "context engineering v2" rewrite.** Rejected: these are surgical,
  independently shippable items; a rewrite risks the four-port runtime invariant,
  the one structure brewva must never duplicate.
- **For G, fold the systemPrompt overlay into `materialize()`** so `PromptPlan`
  becomes the full truth. Considered and set aside: it pulls environment and
  file reads into the pure projection, coupling runtime physics into the model
  port and risking the determinism the projection is meant to guarantee. G1/G2
  keep the projection pure and make the boundary explicit instead.
- **For C, borrow `opencode`'s whole-workspace snapshot restore.** Rejected: that
  is universal undo, the promise the effect-approval lineage rejects. Only the
  identity-check idea is borrowed.

## Risks

- **F's regenerate-and-diff turns noisy** if the capability set legitimately
  evolves. Mitigation: the test reads the documented set as its single source, so
  evolution updates doc and test in one place (capability single-sourcing).
- **G1 risks taping secret-bearing prompt content.** Mitigation: digest/hash
  only, reusing the existing redaction layers and the active-note projection
  discipline; never raw prompt text.
- **C's reject path could block legitimate mid-turn surface evolution.**
  Mitigation: scope strictly to identity drift within one accepted turn; ship
  advisory-flag first, reject second.
- **E over-naming ossifies a spine that should stay flexible.** Mitigation:
  phases are descriptive tags over the existing array, not a new dispatcher; the
  array stays the assembly point.

## Related Docs

- `docs/architecture/design-axioms.md`
- `docs/architecture/invariants-and-reliability.md`
- `docs/architecture/system-architecture.md`
- `docs/journeys/internal/hosted-behavior-installation.md`
- `docs/reference/runtime.md`
- `docs/reference/extensions.md`
- `docs/research/decisions/managed-tool-capability-proof.md`
- `docs/research/decisions/turn-lifecycle-spine.md`
- `docs/research/decisions/hosted-materialization-plan.md`
- `docs/research/decisions/prefix-stable-context-management-and-progressive-compaction.md`
- `docs/research/decisions/token-cache-fidelity-and-provider-prefix-stability.md`
- `docs/research/active/rfc-attention-as-an-accountable-effect.md`
- `docs/research/active/axiom-negative-space-and-decisions-demotion.md`
