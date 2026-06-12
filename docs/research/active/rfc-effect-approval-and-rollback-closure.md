# RFC: Effect Approval And Rollback Closure

## Metadata

- Status: active (implemented; awaiting promotion review)
- Implementation state: single-tool-call closure implemented end to end —
  canonical argument digest, kernel approval enforcement at admission and
  commit, the kernel-owned approval decision writer, expiry with durable
  `tool.started` execution receipts, default hosted rollback over the
  validated patch lifecycle, integration views, and fitness guards. The
  remaining tracked item is the per-entry patch-mutation WAL (see "tracked
  for future model work").
- Owner: Runtime, gateway, tools, and operator-experience maintainers
- Last reviewed: `2026-06-13`
- Promotion target:
  - `docs/journeys/operator/approval-and-rollback.md`
  - `docs/architecture/design-axioms.md`
  - `docs/architecture/invariants-and-reliability.md`
  - `docs/architecture/exploration-and-effect-governance.md`
  - `docs/reference/proposal-boundary.md`
  - `docs/reference/tools.md`
  - `docs/reference/events/tools.md`
  - `docs/reference/runtime.md`

## Problem Statement

Brewva already has the right architectural taste for approval and rollback:
models may explore freely, the kernel owns consequence, tape owns committed
truth, and rollback is a receipt-aware lifecycle over tracked mutations rather
than a generic undo promise.

The active gap is closure. The stable journey describes effect commitment,
operator approval, exact resume, durable linked tool result recording, approval
consumption, and rollback. The implementation has strong pieces of that path:
tool proposals, approval requests, durable approval decisions, runtime
suspension, source patch preparation, mutation receipts, rollback artifacts, and
channel routing for pending or accepted approvals. The pieces are not yet hard
enough as one kernel-owned transaction boundary.

The integration gap matters as much as the kernel gap. `effect_commitment`,
exact resume, proposal requests, `PatchSet`, source patch lifecycle, and
operator safety projection are precise, but precision can become embedder
friction if every host, channel, or CLI surface has to rediscover the same
authority grammar. Brewva should expose a narrow consequence view instead of
asking integrators to reconstruct approval and rollback meaning from raw event
joins.

This RFC proposes making approval and rollback a single consequence-first
closure:

- approval is exact, replay-derived, and consumed by one matching committed
  effect
- commit is impossible for approval-bound calls without the accepted approval
  evidence required by the kernel
- rollback availability is derived from tracked mutation receipts and
  rollback material, not from a UI promise or a generic undo stack
- operator surfaces project authority, evidence, consequence, and recovery
  without becoming authority themselves

## Scope Boundaries

In scope:

- approval-bound tool admission and exact resume
- approval decision replay, consumption, denial, and cancellation semantics
- canonical argument digest semantics for approval-bound calls
- effect commitment vocabulary across stable docs, runtime events, and read
  models
- `SourcePatchPlan`, `PatchSet`, rollback artifact, and `rollback_last_patch`
  wiring
- operator approval and rollback surfaces as evidence projections
- comparison against Claude Code permission UX and Pi Mono edit/session
  mechanics
- validation and promotion criteria for closing the active gap

Out of scope:

- generic undo for arbitrary filesystem, shell, network, or repository effects
- cross-agent saga compensation
- turn-level or workflow-level approval bundles
- hidden planner stages inside the kernel
- making UI state, channel callbacks, or projection caches authoritative
- broadening public runtime construction beyond the four-port runtime root
- default providers, implicit physics modes, or private runtime seams
- history-rewriting Git workflows as rollback semantics

Out of scope but tracked for future model work:

- idempotency-key conventions for externally observable backend effects
- multi-tool approval batches once single-tool-call closure is proven
- repository governance consuming runtime receipts for review or merge
  confidence
- richer denial feedback loops that feed the next model turn without widening
  kernel authority
- model-visible pending-approval narration owned by gateway projections, not
  by model-port admission or kernel path planning
- a full patch-mutation saga (started -> per-entry progress -> completed) for
  `source_patch_apply` and rollback execution. The current closure records
  artifact identity on apply receipts and a durable `rollback.started`
  receipt before any rollback mutation, but a crash mid-mutation still
  leaves a world/receipt gap that only a per-entry WAL closes; that rework
  belongs to the apply pipeline, not this closure

## Why

Future models will become better at planning, re-synthesizing calls, and
continuing after interruption. That increases the value of exact authority
binding. A human approval for one call must not silently authorize a later
similar-looking call. A rollback button must not imply recoverability for
effects that have no tracked mutation receipt. A UI card must not become a
second source of truth because it happened to render the pending request.

The approval and rollback path is where Brewva can be most distinctive.
Conventional agents tend to center permission prompts, mode switches, and
conversation-local callbacks. Brewva can center consequence:

- the model owns attention and proposes effects
- the kernel owns whether an effect may commit
- tape owns the committed approval, result, and rollback evidence
- runtime physics decides what recovery material is available
- operator surfaces explain the closure without becoming the closure

This is stronger than "ask the user before dangerous tools." It is also
stronger than a generic transcript undo. The distinctive product promise should
be that every world-changing action has evidence, exact replay meaning,
inspection affordance, and an honest recovery boundary.

That makes inspect and replay the moat. Claude Code can be excellent at
permission prompts, and Pi Mono can be excellent at a minimal extension shell.
Brewva should be excellent at answering a harder operator question after the
fact: what was approved, why was it allowed or denied, what exactly committed,
and what can still be recovered?

## Direction

Brewva should make effect approval and rollback an explicit consequence
closure. The operator-facing grammar is:

`propose -> defer -> decide -> resume exact call -> commit result -> consume approval -> recover if tracked`

The kernel-facing contract is narrower:

1. **Exact approval binding.** An accepted approval binds to one canonical call
   identity: session, turn when present, tool call id, tool name, cwd,
   approval reason, and canonical argument digest.
2. **Commit-before-consume discipline.** Approval is consumed only when the
   durable linked tool result is committed. A projection may derive consumed
   state from committed evidence; if a separate consumed event is introduced,
   it must be receipt-only and must not become a second authority owner.
3. **Denied means not committable.** Denied or cancelled approval-bound calls
   cannot commit a result through the kernel, even if a caller still knows the
   commitment id.
4. **Rollback is receipt-limited.** Rollback exists only for tracked mutation
   receipts with sufficient rollback material. No-candidate and failure states
   are first-class results.
5. **Operator UX is a projection.** Approval cards, channel callbacks,
   cockpit views, and inspect screens render exact authority and recovery
   evidence. They do not grant capability, bypass policy, or mutate replay
   truth outside kernel/runtime ops.

This keeps Brewva's aesthetic simple:

`Deliberation searches for paths. Kernel judges effects. Tape remembers what happened.`

## Architectural Positions

- **Approval closure belongs in the kernel.** Gateway and channel surfaces may
  route approval turns and emit approval decisions through runtime ops, but the
  runtime kernel should remain the final owner of whether an approval-bound
  commitment may execute or commit.
- **Argument identity is a real digest, not a display label.** Approval read
  models should expose a stable digest of the canonical call arguments. Request
  ids remain request ids. They should not stand in for argument identity.
- **Exact binding has an identity dimension and a time dimension.** Request id,
  tool call id, and canonical argument digest close identity. Expiry, session
  end, and world drift between decision and resume are the time dimension. The
  closure must name explicit terminal states for unresumed approvals instead of
  leaving accepted approvals open-ended as silent capability.
- **Effect vocabulary must converge.** Stable docs should either use the
  current canonical event vocabulary or define explicit aliases from effect
  commitment language to runtime events. Parallel names are acceptable only
  when one is marked as prose and one as event truth.
- **Rollback is not a moral promise.** `SourcePatchPlan` and `PatchSet`
  rollback artifacts are strong because they are evidence-backed. Shell
  effects, external effects, credential access, and budget effects may be
  compensatable, manually recoverable, or irreversible. The product surface
  should show that distinction instead of hiding it behind one undo label.
- **Experience should borrow polish, not authority shape.** Claude Code has
  strong permission-prompt ergonomics. Pi Mono has lightweight edit previews,
  mutation serialization, and session mechanics. Brewva should learn those
  surfaces while preserving kernel/tape authority as its own center of gravity.
- **Integration should happen through authority views.** Embedders should not
  reimplement approval joins, capability checks, or rollback discovery from raw
  events. They should consume narrow views such as `OperatorSafetyDecisionView`,
  pending approval rows, exact resume handles, and rollback candidate summaries.
- **Advisory intelligence may be smart; the kernel must stay dumb.** Bash
  classifiers, risk scores, attention ranking, denial feedback, and permission
  explainers may reduce operator noise. They produce evidence and projection
  hints, not persistent allow authority.
- **Time travel has two honest primitives.** Session rewind or fork changes the
  conversation lineage. Patch rollback changes tracked workspace mutations.
  Product surfaces may compose them, but runtime docs should not blur them.

## Source Anchors

Stable Brewva docs:
`docs/journeys/operator/approval-and-rollback.md`,
`docs/architecture/design-axioms.md`,
`docs/architecture/invariants-and-reliability.md`,
`docs/architecture/exploration-and-effect-governance.md`,
`docs/reference/proposal-boundary.md`, `docs/reference/tools.md`,
`docs/reference/events/tools.md`, and `docs/reference/runtime.md`.

Accepted decision anchors:
`docs/research/decisions/rollback-ergonomics-and-patch-lifecycle-safety.md`
and `docs/research/decisions/effect-authority-manifest.md`.

Implementation anchors:

- runtime authority:
  `packages/brewva-runtime/src/runtime/kernel/impl.ts`,
  `packages/brewva-runtime/src/runtime/kernel/port.ts`,
  `packages/brewva-runtime/src/runtime/kernel/policy/tool-admission-policy.ts`,
  `packages/brewva-runtime/src/runtime/kernel/policy/tool-decision.ts`, and
  `packages/brewva-runtime/src/runtime/turn/impl.ts`
- approval projections and routing:
  `packages/brewva-gateway/src/hosted/internal/session/runtime-ops-builders/proposals.ts`,
  `packages/brewva-gateway/src/hosted/internal/session/runtime-ops-builders/proposal-requests/read-model.ts`,
  `packages/brewva-gateway/src/channels/session/coordinator.ts`, and
  `packages/brewva-gateway/src/channels/session/queries.ts`
- patch and rollback:
  `packages/brewva-tools/src/families/navigation/source-patch.ts`,
  `packages/brewva-tools/src/families/workflow/rollback-last-patch.ts`,
  `packages/brewva-gateway/src/hosted/internal/session/runtime-ops-builders/tools.ts`,
  and `packages/brewva-tools/src/contracts/runtime.ts`

Verification anchors include the runtime kernel transaction, runtime turn-loop,
gateway runtime-events query, channel approval routing, source patch protocol,
tools source patch, and CLI undo tests.

External comparison anchors:

- Claude Code permission types, permission resolver, permission setup, Bash
  permission request, and remote session manager under
  `/Users/bytedance/new_py/claude-code`
- Pi Mono agent loop, edit tool, file mutation queue, and session manager under
  `/Users/bytedance/new_py/pi-mono`

## Architecture Proposal

### 1. Canonicalize Effect Commitment Vocabulary

Create one canonical mapping between stable prose and runtime events.

Preferred direction:

- `tool.proposed` is the durable proposed effect commitment
- `approval.requested` is the durable approval request
- `approval.decided` is the durable operator decision
- `tool.started` is the durable execution-start receipt for approval-bound
  commitments, recorded by the kernel when an accepted closure is admitted
- `tool.committed` is the durable linked effect result
- approval consumed is replay-derived from accepted approval plus linked
  committed result
- rollback events remain owned by the mutation and patch lifecycle

If stable docs keep `effect_commitment_*` names, they should identify those
names as operator-facing prose aliases. Runtime event references should name
the actual event family. If a first-class `approval.consumed` event is added,
it should be emitted after `tool.committed` and only mirror the closure already
proven by the committed result.

This avoids a split where architecture prose, read models, and runtime event
truth appear to describe three different systems.

### 2. Make Exact Approval Resume A Kernel Admission Rule

The kernel should enforce approval-bound resume with replay-derived evidence.

#### Prerequisite: Replay-Derived Approval State Inside The Kernel

Every admission rule in this section reads approval state, and none of them
can be enforced until the kernel can answer "what is the durable approval
posture of this commitment" from tape. Today the kernel tracks commitments in
a process-local map and does not rehydrate `approval.requested` or
`approval.decided` events on restart, so after a restart it cannot
distinguish pending, accepted, denied, or cancelled approval-bound calls.

The structural ordering is therefore explicit: the kernel first gains a
replay-derived approval state projection of its own, then exact binding,
denial terminality, and consumption checks are built on top of it. Gateway
read models keep their own projections for display, but they remain
projections. Admission-bearing approval state must be derived inside the
kernel from the same durable events, never from gateway caches, channel
callbacks, or in-memory pending maps.

Required semantics: approval-bound calls defer until a request exists;
accepted approval allows only the exact matching call identity; denied or
cancelled approval blocks commit; accepted approval cannot be reused after the
linked result commits; argument identity uses canonical digest; mismatched
resume attempts record explicit abort or denied admission reason; restart
hydration derives the same state from tape without process-local pending maps.

Implementation options:

1. Keep `beginToolCall` as the admission API and make it return `allow` only
   when the approval-bound call has a matching accepted approval.
2. Add a narrower resume API such as `resumeApprovedToolCall(...)` that carries
   request id, tool call id, and argument digest, then lets `beginToolCall`
   remain the ordinary proposal path.

The first option has less public surface. The second option makes exact resume
more explicit. Either way, `commitToolResult` must verify that approval-bound
commitments have accepted approval evidence before committing.

#### Canonical Argument Digest Is A Persisted Contract

Exact binding stands on the digest, so the digest algorithm is itself a
persisted format, not an implementation detail. Once a canonical digest is
recorded on tape, replay across runtime versions must reproduce the same
digest for the same logical call, or exact resume will misclassify historical
approvals as mismatches.

Required properties:

- the canonicalization rules are written down as a contract: key ordering,
  treatment of absent versus `undefined` versus `null` fields, numeric and
  unicode normalization, and the exact serialization the digest hashes over
- the persisted payload carries an explicit digest algorithm/version identity,
  so a future canonicalization change creates a new version instead of
  silently invalidating previously recorded approvals
- digest computation lives in one shared module consumed by kernel admission,
  read models, and integration views; no surface re-derives it ad hoc
- replay tests prove digest stability: a tape written by one version must
  verify under the next, and a canonicalization mismatch surfaces as a
  version difference, not as a silent approval mismatch

The current approval read model exposes the request id under an `argsDigest`
field. That is a display label standing in for argument identity and must be
replaced by the real digest. Request ids remain request ids.

### 3. Close Denial, Cancellation, And Consumption Semantics

Denial and cancellation should be terminal for the exact pending approval
request. The kernel should not permit a later result commit for that
approval-bound commitment unless a new proposal and a new approval request are
created with a distinct identity.

Consumption should be one of two shapes:

- derived: accepted approval plus matching `tool.committed` projects to
  consumed
- explicit: `approval.consumed` records the consumed projection after the
  matching `tool.committed`

The derived shape is preferable until debugging or external protocol needs
prove that an explicit consumed event earns its extra persisted surface.

Derived consumption must be derived in the kernel. Today consumed posture is
computed only in a gateway read model, which is exactly the
projection-as-authority drift this RFC forbids, mirrored: the only place the
closure exists is a surface that owns no authority. The enforcement point is
`commitToolResult`: before committing an approval-bound result, the kernel
checks its replay-derived approval state for an accepted, not-yet-consumed
approval with matching canonical identity. Gateway projections may mirror
consumed posture for display; they may not be the only place it exists.

Concurrent decisions need one rule. Two operator surfaces — a channel card
and a CLI prompt, for example — may decide the same pending request at nearly
the same time. The first durable `approval.decided` event on tape wins. A
later decision for the same request records as a no-op receipt with an
explicit already-decided reason rather than overwriting or erroring opaquely.
Kernel admission and every read model must derive the winner from the same
tape order, never from arrival order at a particular surface.

Approval binding also has a time dimension that identity alone does not
close. The closure defines it as follows:

- The time bound is declared, never implied. An approval-bound call may
  carry `approval.expiresAt` (epoch ms); the kernel stamps it onto the
  approval request. Absent a bound, the request stays open until decided,
  cancelled, or consumed — no hidden default TTL.
- The bound restricts when execution may start, never whether a begun
  execution may finish. Admission of an accepted closure records a durable
  `tool.started` receipt; a result produced by an execution that started
  before the bound may commit after it — the tape never records a happened
  effect as aborted. Any authority touch at or after the bound on a closure
  with no pre-bound start receipt records a durable `tool.aborted` receipt
  with reason `approval_request_expired` and blocks. The rule covers pending
  requests and valid-but-unexercised acceptances alike, so a dangling
  acceptance terminalizes instead of persisting as silent capability.
- Approval authority enters the tape through exactly one writer. The kernel
  exposes the canonical approval decision writer; it stamps decision
  timestamps from the kernel clock (callers cannot backdate past the bound)
  and enforces first-writer-wins at write time while still recording late
  attempts as durable no-op receipts. Advisory events — including
  `runtime.ops` mirrors that reuse canonical event names — never bear
  decision authority, in the kernel or in any projection.
- Decision validity is judged by tape timestamps. A decision recorded at or
  after `expiresAt` does not bind authority; it stays on tape as a no-op
  receipt. The effective decision is the first durable decision recorded
  strictly before the bound. Because both timestamps are durable, replay is
  deterministic; the evaluation clock only chooses when the terminal receipt
  gets written, never what the authority outcome is.
- There is no background timer. Expiry is enforced lazily at authority
  touches and becomes durable truth through the receipt it produces. Read
  models may project open rows past their bound as `expired` for display;
  the projection grants and revokes nothing.
- A closure completed before the bound is immune to it: committed results
  stay committed, and a valid pre-expiry denial or cancellation keeps its
  own terminal meaning rather than converting to expired.
- Session end is not a separate primitive. Approval identity binds the
  session structurally, replay hydration restores open requests after
  restart, and dangling rows stay visible to operator surfaces until expiry,
  decision, or cancellation closes them.

Separately, the world can drift between decision and resume: the operator
approved against evidence captured at request time, and the workspace may
have changed since. Source patches already guard this with preflight
conflict checks; other approval-bound tools have no staleness check today.
This RFC does not prescribe a universal staleness mechanism, but the gap is
real and is tracked in Open Questions.

The important invariant is not the event count. The invariant is that
approval-bound authority closes over exactly one committed effect.

### 4. Wire Rollback To The Patch Lifecycle By Default

`rollback_last_patch` should either work from default hosted runtime
capabilities or the stable docs should explicitly state that a host must install
the rollback capability.

Preferred direction:

- runtime tools expose `rollbackLastPatchSet(sessionId)` by default when patch
  history is available
- the implementation reads the latest tracked `PatchSet` for the target
  session, validates rollback artifact availability, restores tracked mutations,
  and records rollback evidence
- no-candidate, artifact-missing, conflict, partial-failure, and success states
  are explicit
- redo remains a separate capability and does not imply hidden history rewrite
- legacy CLI undo and source-patch rollback must converge on one patch
  lifecycle. Both already read the same artifact store under the session patch
  history; only the reading logic is duplicated. The end state is one
  lifecycle with two entrypoints — the CLI flag and the runtime tool — backed
  by the same candidate discovery, artifact validation, and rollback evidence.
  Two divergent implementations over shared storage is not an acceptable
  terminal state for this RFC

This preserves Brewva's most important rollback claim: rollback is not generic
undo; it is recovery over known tracked mutation material.

### 5. Make Operator Experience Evidence-Native

Borrow Claude Code's prompt ergonomics without copying its authority model.

Approval cards should show exact request id, tool call id, tool name, cwd,
argument digest, boundary, action class, risk, declared effects,
recoverability, visibility, rollback-material posture, affected resources, why
the kernel is asking, and whether approval will be consumed once. Actions
should include allow once, deny, cancel, and deny-with-feedback. Scoped rule
creation is acceptable only when the rule becomes ordinary policy input rather
than UI-local privilege.

Borrow Pi Mono's edit ergonomics without copying its lighter authority model.

Source patch approval and rollback views should show concise diff preview,
stale-file or conflict status, per-file mutation serialization when relevant,
rollback artifact availability, and exact `PatchSet` and `SourcePatchPlan`
identifiers.

The product grammar should be:

`Operator sees work cards. Kernel sees receipts. Model sees consequences and recovery options.`

### 6. Expose A Narrow Integration View

Hosts, channels, CLIs, and future SDK users should not need to understand the
full event grammar before they can render a correct approval or rollback
surface. Brewva should provide a narrow integration view that answers:

- what authority decision is currently visible?
- what exact request id, tool call id, and argument digest must be resumed?
- what consequence posture and recovery posture should the operator see?
- what receipts prove the decision?
- is there a rollback candidate, and what material backs it?
- what action can the embedder take without widening authority?

`OperatorSafetyDecisionView` is already the right shape for the first part of
this surface. The approval path should add or document the complementary exact
resume view: request identity, canonical call identity, decision state,
consumption state, and safe invocation entrypoint. The rollback path should add
or document the complementary rollback candidate view: latest tracked
`PatchSet`, affected paths, artifact availability, and no-candidate reason.

This keeps integration through authority ports rather than through prompts.

### 7. Make Inspect, Replay, And Time Travel One Operator Story

Approval and rollback should become one operator story instead of separate
feature islands:

- inspect approval: show why a call deferred, who decided, what exact call may
  resume, and which receipts prove the state
- inspect effect: show what committed, which approval or direct policy allowed
  it, and whether the result has mutation or recovery evidence
- inspect rollback: show the latest tracked patch set, artifact state,
  conflict state, and explicit no-candidate reason
- session rewind: fork or rewind conversation lineage without pretending to
  restore workspace state
- patch rollback: restore tracked workspace mutations without pretending to
  rewrite model history
- full recovery: compose lineage rewind plus patch rollback only when both
  evidence chains are present

This gives Brewva a clearer external grammar than "permission mode" or "undo."
The system can say exactly which timeline changed and which one did not.

### 8. Keep Advisory Intelligence Outside Kernel Authority

Claude-style classifiers and Pi-style lightweight hooks can make the product
feel faster, but they must remain outside final authority. The acceptable path
is:

`classifier or hook -> evidence/refinement hint -> operator safety projection -> kernel admission still owns commit`

The unacceptable path is:

`classifier or hook -> persistent allow -> future similar calls bypass exact approval`

Broad allow rule linting should exist before persistent policy input is saved.
The linter may inspect shell wildcard rules, delegated-agent rules,
credential-bearing tools, external account tools, and path-wide edit grants. It
should block, warn, or require narrower scoping through ordinary policy
mechanisms. It must not create a shadow permission store.

### 9. Keep The Boundary Single-Tool Until It Is Proven

This RFC intentionally does not introduce turn-level approval bundles, workflow
sagas, or multi-agent compensation. The current stable authority-bearing
transaction boundary remains one tool call.

Future broader approval shapes should wait until single-call closure has exact
resume tests, denial and cancellation terminal-state tests, restart hydration
tests, rollback no-candidate and artifact-missing tests, and operator
projection tests that prove UI state does not widen authority.

## External Comparison

Claude Code is strongest as an operator UX reference: permission cards, scoped
allow-once flows, rule-add flows, dangerous broad allowlist detection,
deny-with-feedback, classifier review, and remote pending permission queues.
Brewva should learn that polish while refusing to move authority into UI-local
callbacks, permission modes, or broad bypass behavior.

Pi Mono is strongest as an operational-lightness reference: a small agent loop,
crisp edit preview, exact file mutation handling, per-file mutation
serialization, and append-only session navigation. Brewva should borrow those
editing and inspection ergonomics while keeping hook-based blocking, generic UI
undo, and session summaries outside runtime authority.

The comparison should shape prioritization: subtract product clutter where Pi
is right, polish approval cards where Claude Code is right, and keep effect
commitment, tape, exact approval, and patch lifecycle non-optional where
Brewva is right.

## Validation Signals

Kernel and runtime validation should prove approval-bound defer, accepted exact
resume, one-time consumption, denial and cancellation non-commit, argument
digest mismatch rejection, new approval for a new tool call id, and restart
hydration for pending, accepted, denied, cancelled, and consumed posture.

One existing test currently locks in the inverted behavior: the runtime events
query suite asserts that a denied approval-bound commitment can still commit
its result. Closure must flip that assertion, not merely add new tests beside
it — until the old test is inverted, the suite actively defends the bug as a
regression guard.

Digest validation should prove canonicalization stability across replay: a
digest recorded by one runtime version verifies under the next, a
canonicalization change surfaces as an explicit version difference rather
than a silent approval mismatch, and every surface computes the digest
through the shared module rather than re-deriving it.

Concurrency validation should prove that two near-simultaneous decisions for
the same pending request resolve to the first durable decision on tape, with
the later decision recorded as an explicit already-decided receipt, and that
kernel admission and read models agree on the winner.

Gateway and channel validation should prove pending and accepted approvals
route to the original agent/session target, unresolved approval requests fail
closed, read models expose request id and actual argument digest separately,
and UI/projector actions do not grant authority without runtime ops events.

Rollback and source patch validation should prove prepare never mutates, apply
writes rollback material before mutation, preflight conflicts avoid partial
mutation, rollback restores only tracked mutations, no-candidate and
artifact-missing states are explicit, and legacy CLI undo is either converged
with or clearly separated from source patch rollback evidence.

Docs and product validation should prove canonical event vocabulary, distinct
effectful/approval/recoverability language, evidence-native operator screens,
and safety linting for broad allow rules before they become persistent policy.

Fitness validation should encode the architectural taste directly: no second
proposal kind without a new accepted decision, no model-port admission path, no
rollback wording that implies universal undo, no projection that widens kernel
authority, and no prompt or skill card that grants external capability.

## Promotion Criteria

This RFC can move to `docs/research/decisions/` when:

- kernel approval state is replay-derived; no process-local pending map is
  load-bearing for admission or commit decisions
- kernel admission enforces accepted exact approval before approval-bound
  commit
- denied and cancelled approval-bound commitments cannot commit results
- the existing test asserting that denied approval-bound commitments can
  still commit results is inverted
- argument digest is canonical and exposed separately from request id
- the digest canonicalization rules are documented as a persisted contract
  with an explicit algorithm/version identity, and digest-stability replay
  tests exist
- concurrent decision semantics are documented and tested: the first durable
  decision on tape wins, later decisions record as already-decided receipts
- expiry and session-end semantics for pending and accepted approvals are
  defined with explicit terminal states
- approval consumed posture is either replay-derived and documented or recorded
  as a narrow receipt event
- `rollback_last_patch` has a default hosted capability path or stable docs
  state the required host capability explicitly
- legacy CLI undo and `rollback_last_patch` converge on one patch lifecycle
  with shared candidate discovery, artifact validation, and rollback evidence
- tests cover exact resume, denial, cancellation, reuse prevention, restart
  hydration, source patch rollback, and no-candidate rollback
- stable docs no longer carry conflicting event vocabulary
- operator UX requirements are represented as projections over receipts rather
  than a second authority model
- integration views expose approval, exact resume, and rollback candidate
  evidence without requiring embedders to reconstruct authority joins
- inspect and recovery docs distinguish session rewind, patch rollback, and
  composed full recovery
- fitness tests enforce the no-second-authority constraints that define the
  Brewva approval and rollback aesthetic

## Surface Budget

This RFC is intended to harden existing surfaces rather than widen authored
surface area.

- Required authored fields: before `0`, after `0`.
- Optional authored fields: before `0`, after `0`.
- Author-facing concepts: before `4`, after `4`. Existing concepts stay
  approval request, effect commitment, patch rollback, and recovery posture.
- Inspect surfaces: before `4`, after `4`. Existing proposal requests, tool
  access explanation, inspect, and rollback output gain evidence density rather
  than a new inspect host.
- Routing/control-plane decision points: before `2`, after `2`. Existing
  approval decision routing and rollback capability selection stay in place;
  kernel admission becomes stricter inside the existing tool transaction.
- Persisted formats: before `0` new fields, after `2` authority-bearing
  fields, one new canonical event type, and receipt-only annotations. The
  approval request payload gains `argsDigest` (the canonical argument digest
  with its algorithm/version identity embedded in the string form) and
  optional `expiresAt` (the closure bound). The canonical event vocabulary
  gains `tool.started`, the durable execution-start receipt that lets the
  closure bound restrict execution start without ever negating a begun
  execution. Late-decision no-op receipts annotate their `approval.decided`
  events with `applied: false`, `outcome`, and `priorState`; these fields are
  receipt-only and never participate in authority derivation. Apply receipts
  gain `rollbackArtifactRef` and rollback attempts record `rollback.started`
  before mutating, so artifact identity and mutation-began evidence are
  durable instead of directory conventions. Consumed posture stays derived
  from accepted approval plus linked `tool.committed`; no consumed event was
  added. Independent of field count, the digest canonicalization rules are
  governed as a persisted contract: changing them is a persisted-format
  change even when no field is added.
- Kernel port width: `recordApprovalDecision` is added as the single
  canonical approval decision writer. This is authority width, not
  convenience width: removing it would push decision authorship back into
  advisory events.
- Migration posture: approval requests persisted before this closure carry no
  `argsDigest`. They fail closed — the kernel resolves them as unreadable and
  terminalizes at the next authority touch — because an approval without
  argument-identity evidence cannot be exactly bound. This is a deliberate
  one-way cut, not an oversight; in-flight approvals do not survive the
  upgrade.

Debt owner for any positive persisted-format delta: runtime maintainers.
Re-evaluation trigger: promotion review for this RFC or `2026-07-15`,
whichever comes first.

## Open Questions

- Should approved resume stay inside `beginToolCall`, or should the kernel add
  a narrower resume API?
- Is replay-derived consumed posture enough, or does an explicit consumed event
  earn its persisted surface?
- Should default hosted rollback read patch lifecycle material directly, or
  stay host-installed with stronger docs?
- Should broad allow rule linting live in runtime policy, gateway policy, or
  operator-experience tooling?
- How much denial feedback should be model-visible before it becomes hidden
  steering with authority implications?
- Should pending approval and resumed-effect narration appear in model-visible
  context by default, or only through explicit gateway recovery projections?
- Should approval-bound tools other than source patches re-validate world
  state between decision and resume (a staleness preflight), or is identity
  binding plus operator-visible evidence age sufficient?
- Who owns review when the digest canonicalization contract must change —
  runtime maintainers alone, or runtime plus gateway maintainers, since read
  models and integration views verify digests as well?
