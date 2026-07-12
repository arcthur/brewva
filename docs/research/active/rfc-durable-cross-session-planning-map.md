# RFC: Durable Cross-Session Planning Map — The Third Leg Beside Lossy Continuation And Single Persistent Intent

## Metadata

- Status: active
- Implementation state: Phase 1 MVP landed as a green vertical slice. Implemented:
  the pure `plan-map` vocabulary (`plan.map.*` / `plan.ticket.*` events, the
  deterministic `foldPlanMapEvents` projection, and the frontier / decisions /
  out-of-scope / invalidated selectors); the effort-scoped, multi-writer durable
  sidecar store; the `planMap` runtime-ops capability (controller + builder +
  capability port); and six capability-scoped managed tools (`create_plan_map`,
  `get_plan_map`, `open_plan_ticket`, `claim_plan_ticket`, `resolve_plan_ticket`,
  `close_plan_ticket`) wired into the default bundle and admission policy. Covered by
  vocabulary / gateway / tools unit tests, the shared managed-tool contract test, and
  fitness guards (capability inventory, vocabulary boundary, and plan-not-execute),
  with `bun run check` and the full `bun run test:ci` suite green. Phase 2 has now
  landed in full: `plan.ticket.claimed` / `.unclaimed` (first-claim-in-file-order-wins
  mutual exclusion with a `claim_lost` result for a raced loser, plus an open `unclaim`
  so a crashed or abandoned session's claim can be recovered instead of stranding the
  ticket forever); the fog family (`plan.fog.recorded` / `.graduated`, whose graduation
  lineage — which tickets a fog patch became — is projected, not a write-only tape
  audit); in-place ticket re-framing (`plan.ticket.rescoped`); and the `/map`
  interactive + owner-gated channel command surface (`chart` / `show` / `take` /
  `resolve`, keyed by an explicit `mapId`). Ten capability-scoped managed tools ship,
  gated behind an opt-in `planning.mapEnabled` config flag (default off) so they stay
  out of a session's prompt budget while cross-session demand is unproven. The frontier
  invariant is property-tested. Only Phase 3 (real-session demand measurement) remains
  — it needs production telemetry, not code — so the RFC stays active and is not
  promotable yet.
- Owner: Substrate, runtime, and gateway maintainers
- Last reviewed: `2026-07-12`
- Depends on:
  - [Decision: Goal Control Plane](../decisions/goal-control-plane.md)
    (`goal.*` lifecycle events + `goal.state.get` tape rebuild + capability-scoped
    `get_goal`/`update_goal` — the exact pattern the plan-map family mirrors on a
    decomposed-plan axis instead of a single-intent axis)
  - [Decision: Durable Steering Inbox](../decisions/durable-steering-inbox.md)
    (session-scoped sidecar `.brewva/steering/<session>.jsonl` reusing WAL helpers
    — the durable-sidecar precedent for the map MVP)
  - [Decision: Session Index Read-Model Engine](../decisions/session-index-read-model-engine.md)
    (rebuildable read model over the tape — the precedent for the frontier query)
  - [Decision: Tree History And Multi-Writer Substrate](../decisions/tree-history-and-multi-writer-substrate.md)
    (parent-pointer lineage + single-writer discipline — the precedent for ticket
    blocking edges and concurrent-session coordination)
  - [Decision: Context Operating System And Compaction Physics](../decisions/context-operating-system-and-compaction-physics.md)
    (compaction ownership — the lossy-continuation leg this RFC positions against)
- Also related:
  - [RFC: User Model As A Tape-Folded Advisory Projection](../decisions/rfc-user-model-as-a-tape-folded-advisory-projection.md)
    (tape-folded advisory projection — the shape the map projection takes)
  - [RFC: Pre-Compaction Deterministic Prune](./rfc-pre-compaction-deterministic-prune.md)
    (the deterministic pre-summarization pass; a compaction-side optimization, not
    an externalization)
  - [Decision: Crash-Safe Durable Substrate](../decisions/crash-safe-durable-substrate.md)
    (the durability posture the map inherits; see Open Questions on power-safety)
- Promotion target:
  - `docs/reference/runtime.md` (planning-map contract)
  - `docs/reference/commands/interactive.md` (the map command surface)
  - `packages/brewva-vocabulary/src/internal/goal.ts` (the sibling event family the
    plan-map family lives beside)

## Problem Statement

Brewva's planning suite — `office-hours` → `discovery` → `strategy` → `plan` →
`prep` → `implementation`/`greenfield` — is entirely **single-turn and bounded**.
Each skill produces structured handoff artifacts (`design_spec`,
`strategy_review`, `execution_plan`, `implementation_targets`) that the next skill
consumes **inside the same conversation**. The `plan` skill is explicit that it
emits a _bounded_ plan; none of these skills persist an externalized planning
artifact that survives a session boundary.

That leaves a class of work uncovered: an effort that is (a) **larger than one
context window** and (b) still in **fog** — where the destination is knowable but
the route is not, and you cannot yet enumerate every decision, let alone define a
convergence metric. This is exactly the regime a loosely-scoped design initiative,
a data-structure migration, or a "figure out how we should even approach X" brief
falls into.

Brewva has two mechanisms adjacent to this regime, and neither covers it:

1. **Compaction** (lossy continuation). When one session's context grows past the
   budget, compaction summarizes the tail and continues in-band. It manages _the
   context you keep_. But the open-decision structure of a plan is precisely the
   thing summarization flattens: after a compaction, "seven decisions still open,
   three of them blocked on the auth question" degrades into prose. Compaction is
   the right tool for continuity and the wrong tool for a plan, because a plan is
   what you least want to lossily summarize.

2. **Goal control plane** (single persistent intent). `/goal` persists **one**
   operator intent across a session's turns, rebuilt from `goal.*` receipts by
   `goal.state.get`, with budget, continuation, and blocker lifecycle. It holds a
   _goal string_, not a _decomposed frontier of open decisions_. Its own
   Non-Goals explicitly defer **"cross-session inheritance, multi-agent fanout"** —
   the precise space a decomposed, resumable plan would own.

The gap: there is no **durable, externalized, resumable planning map** for
oversized, foggy work — one that many sessions (agent-only, or human-plus-agent)
chip at one decision at a time, accumulating decided answers and graduating fog
into fresh questions as the frontier advances, until the route to the destination
is clear.

The external `wayfinder` skill (superpowers-family) is a mature articulation of
this methodology: it charts the plan as a shared map of investigation _tickets_ on
an issue tracker, resolves them one per session, and tracks a "fog of war" of
not-yet-specifiable questions. Its assumption — an external issue tracker — is the
one thing brewva should _not_ copy: brewva already owns better substrate for it.

## The Third Leg

Position the three answers to "the work does not fit in one context" explicitly:

| Leg | Mechanism                   | Unit                               | Fidelity                   | Span                     | Owner today                            |
| --- | --------------------------- | ---------------------------------- | -------------------------- | ------------------------ | -------------------------------------- |
| 1   | **Compaction**              | the retained context tail          | **lossy** (summarized)     | within one session       | compaction physics                     |
| 2   | **Goal control plane**      | one persistent intent              | lossless, but singular     | across a session's turns | `goal.*` + `goal.state.get`            |
| 3   | **Planning map** (this RFC) | a decomposed frontier of decisions | **lossless, externalized** | across many sessions     | _(proposed)_ `plan.map.*` + projection |

The three are complementary layers of the same problem, not competitors.
Compaction manages the tail you must keep in context; the goal plane holds the
one intent you are steering toward; the map holds the plan you **do not need to
keep in context at all** — because it lives on the tape as receipts and is pulled
back at low resolution only when a session chooses to work it.

## Scope Boundaries

In scope:

- a durable, tape-anchored **map** artifact (a destination, standing notes,
  decided answers, an open frontier, a fog list, and an out-of-scope list)
- **tickets** as child records of the map, each a single-session-sized question,
  carrying a type (`research` / `prototype` / `grilling` / `task` / `decision`)
  and native **blocking** edges to other tickets
- a **claim** primitive so concurrent sessions take disjoint tickets
- a read-only **projection** (`plan.map.state.get`) that rebuilds the low-res map
  and computes the **frontier** (open ∧ unblocked ∧ unclaimed) from receipts
- **fog graduation**: resolving a ticket may open fresh tickets and clear a fog
  patch; mis-scoped tickets are **closed as out-of-scope**, never resolved
- capability-scoped managed tools mirroring `get_goal`/`update_goal`, and a
  `/map` command surface sharing grammar with `/goal`

Out of scope:

- **execution.** The map is a planning artifact. Resolving a ticket records a
  _decision receipt_, never a world effect. Carrying a decided plan into code is
  the existing `plan` → `prep` → `implementation` handoff, unchanged.
- **an external issue tracker.** The map lives on brewva's tape, not GitHub. No
  new network authority, no credentials, no unowned truth source.
- **a runtime planner / auto-dispatch.** The frontier is a _view_ the model or
  operator reads to _choose_ the next ticket. Nothing auto-runs a ticket.
- **changing the transaction boundary.** Concurrent sessions coordinate through
  append-only receipts and the claim primitive; there is no saga, no compensation
  graph, no cross-agent partial-failure repair. The boundary stays `single tool
call` (axiom 17).
- **auto-injection into context.** The map is explicit-pull, like inspect views;
  it never auto-pushes into model-visible context each turn (axiom 1).

Out of scope but tracked:

- **cross-repository maps** (an effort spanning several repos) — deferred until a
  single-repo map is proven.
- **map-level budget accounting** (aggregate token cost of an effort across its
  sessions) — the goal plane already prices single-intent continuation; a map-wide
  roll-up is a later join, not Phase 1.

## Why

### Why externalize the plan instead of compacting it

Compaction is lossy by construction — it trades fidelity for continuity. A plan's
value is in its _structure_: which decisions are made, which are open, which block
which, and which are deliberately out of scope. That structure is exactly what a
summarizer erodes. Externalizing the plan as receipts keeps it **lossless and
inspectable** while removing it from the context budget entirely: a resuming
session loads the low-res map (a page, not a transcript) plus the one ticket it
claims, instead of re-deriving the whole plan from a compacted tail. Compaction
still runs — for the working context of each ticket session — but the plan itself
no longer competes for that budget.

### Why on brewva's own substrate, not an external tracker

`wayfinder` leans on an issue tracker because most agents have no durable, ordered,
inspectable commitment log of their own. Brewva does. The map is a natural
tape-folded projection alongside proven precedents:

- `goal.state.get` already rebuilds live state from a `goal.*` receipt stream —
  the map is the same move on a decomposed-plan axis.
- the durable steering inbox already persists a session-scoped sidecar
  (`.brewva/steering/<session>.jsonl`) with WAL helpers — the map MVP is the same
  shape, effort-scoped.
- the session-index read-model engine already rebuilds a queryable view from the
  tape — the frontier is one more such query.
- the user-model RFC already establishes the "tape-folded advisory projection"
  pattern the map projection follows.

An external tracker would add an unowned authority surface, break `Tape owns
truth`, and demand network + credentials for what is fundamentally a local
planning artifact. Reusing the substrate keeps the map inside the effect-governance,
replay, and durability guarantees brewva already enforces.

### Why this is not already covered

- **`plan` / `strategy` / `discovery`** are bounded single-turn skills with in-band
  handoffs. They are the _workers_ the map sequences across sessions — not a
  durable, resumable plan.
- **`goal-loop`** requires an _observable convergence predicate_ and routes fog
  back to `plan` by its own Iron Law. It is bounded metric-convergence execution;
  the map is fog-clearing discovery, where no metric exists yet.
- **`goal` control plane** persists a single intent and explicitly defers
  cross-session inheritance and multi-agent fanout. The map is the sibling control
  plane that picks up exactly that deferred space, on the planning-decomposition
  axis, as opt-in control-plane behavior.

### Axiom alignment

- **Axiom 1 (`Attention belongs to the model`).** The map is explicit-pull; it
  never auto-injects. A session decides to load it; the runtime does not push it.
- **Axiom 6 (`Tape is commitment memory`).** Every map mutation — opened, claimed,
  resolved, closed, graduated — is a receipt. The map body is a projection, never
  a second source of truth.
- **Axiom 12 (`Product loops are projections, not runtime state machines`).** The
  frontier is a view over ticket receipts. It must not become a hidden planner: no
  auto-dispatch, no runtime-owned plan FSM.
- **Axiom 17 (`Platform growth stays opt-in until multi-agent semantics mature`).**
  Concurrent-session editing is optimistic coordination through append-only
  receipts and a claim primitive — not a saga. Opt-in, boundary unchanged.
- **Axiom 18 (`Descriptive metadata derives views, never authority`).** Resolving a
  ticket derives no gate, activation, or grant. "Plan, don't do" is the axiom
  read literally: the map informs; the human or model still chooses to act.
- **Axiom 19 (`A documented invariant that nothing checks is a promise`).** Each
  structural invariant below (projection determinism, claim exclusion,
  plan-not-execute) ships with a fitness artifact.

## Direction

1. **The map is tape + projection, never a live object.** A `plan.map.*` /
   `plan.ticket.*` event family records the effort; `plan.map.state.get` rebuilds
   the map and frontier deterministically from those receipts, exactly as
   `goal.state.get` does for the goal.

2. **Tickets are single-session-sized questions with native blocking.** Each
   ticket is a child of the map: a `question`, a `type`, and a `blockedBy` set of
   sibling ticket ids recorded on its open receipt. A ticket is **unblocked** when
   every blocker is closed; the **frontier** is open ∧ unblocked ∧ unclaimed.

3. **Claim before work.** A session assigns a ticket to itself
   (`plan.ticket.claimed`) before doing anything, so concurrent sessions skip it.
   The claim receipt _is_ the lock; an open, unassigned ticket is takeable.

4. **Fog is first-class and graduates.** The map carries a **Not yet specified**
   list (in-scope questions too unsharp to ticket) and an **Out of scope** list
   (ruled beyond the destination). Resolving a ticket may **graduate** a fog patch
   into fresh tickets; a mis-scoped ticket is **closed as out-of-scope**, recorded
   but never resolved on the route.

5. **One decision per session; refer by name.** A working session resolves at most
   one ticket, then records the answer and stops — bounded like every other brewva
   turn. Projections render ticket **titles**, not bare ids, honoring the same
   legibility discipline as the skill catalog and the wire-fold transcript.

6. **The map sequences existing skills; it does not replace them.** Each ticket
   type routes to a bounded worker skill: `research` → `learning-research`,
   `grilling` → `office-hours`/`discovery`, `prototype` → `frontend-design`,
   `decision` → `strategy`/`plan`, `task` → `implementation`/operator. The map is
   the durable outer loop; the planning suite is the per-ticket inner loop.

## Architectural Positions

- **The map is a projection, not a planner (axiom 12).** It surfaces the frontier;
  it never dispatches. The model or operator reads it and chooses. There is no
  runtime plan state machine and no second session-lifecycle owner.

- **The map is explicit-pull (axiom 1 + active-notes projection discipline).** It
  is not materialized into model-visible context each turn. A session that works
  the map pulls the low-res view once and zooms individual tickets on demand.
  Opening the projection triggers no recall, capability selection, materialization,
  provider routing, or background delivery.

- **Resolving a ticket is a receipt, not an effect (axiom 18).** The map is planning
  authority only. It records decisions; it grants nothing. Execution stays behind
  the existing `plan` → `prep` → `implementation` handoff and its approval gates.

- **Concurrency is optimistic through the tape (axiom 17).** Sessions append
  receipts independently; the claim primitive gives mutual exclusion on a ticket.
  Last-writer-wins on the projection for non-claim edits. No saga, no compensation
  graph, no partial-failure repair — the transaction boundary is unchanged.

- **The map complements compaction; it does not replace it.** Ticket sessions still
  compact their own working context. The map removes the _plan_ from that budget,
  making each ticket session's compaction shorter and its summary less lossy.

- **Fail closed (projection discipline).** A projection that cannot be rebuilt (a
  corrupt or partial receipt stream) renders a blocked/ask posture, never a
  silently narrower map that hides open decisions.

## Source Anchors

Decisions and RFCs (the substrate and pattern precedents):
`docs/research/decisions/goal-control-plane.md`,
`docs/research/decisions/durable-steering-inbox.md`,
`docs/research/decisions/session-index-read-model-engine.md`,
`docs/research/decisions/tree-history-and-multi-writer-substrate.md`,
`docs/research/decisions/crash-safe-durable-substrate.md`,
`docs/research/decisions/rfc-user-model-as-a-tape-folded-advisory-projection.md`,
`docs/architecture/design-axioms.md` (axioms 1, 6, 12, 17, 18, 19).

Internal implementation anchors (the sibling family to mirror):

- `packages/brewva-vocabulary/src/internal/goal.ts` (the `goal.*` event family;
  the `plan.map.*` / `plan.ticket.*` family lives beside it)
- `packages/brewva-gateway/src/hosted/internal/session/runtime-ops-builders/goal.ts`
  (`goal.state.get` rebuild builder; the map projection mirrors this)
- `packages/brewva-gateway/src/hosted/internal/session/goal-continuation.ts`
  (continuation delivery; the map's resume-a-ticket path is the analog)
- `packages/brewva-tools/src/families/workflow/goal.ts` (`get_goal`/`update_goal`
  managed tools; the map's managed tools mirror the capability scoping)
- `packages/brewva-cli/src/shell/commands/shell-command-registry.ts` and
  `packages/brewva-gateway/src/channels/command/goal.ts` (`/goal` interactive +
  channel grammar; `/map` shares the parser and owner ACL)

External methodology anchor (adapted, not ported): the `wayfinder` skill —
tickets, one-per-session resolution, and fog-of-war graduation. Brewva replaces
its external issue tracker with tape + projection.

## Architecture Proposal

### 1. Event family (vocabulary)

A `plan.map.*` / `plan.ticket.*` family beside `goal.*`, payloads under
`brewva.plan-map.v1`:

```typescript
// Every receipt carries `mapId`: the per-map log is filtered by it, so a ticket
// event that omits `mapId` is silently dropped and its ticket never settles — the
// emit path must stamp it on every event, denormalized (no ticketId -> mapId lookup).

// map lifecycle
plan.map.created         { mapId; destination: string; notes?: string }
plan.map.destination.set { mapId; destination: string }
plan.map.notes.set       { mapId; notes: string }
plan.fog.recorded        { mapId; patchId; text: string }           // Not yet specified
plan.fog.graduated       { mapId; patchId; intoTicketIds: string[] } // fog -> tickets

// ticket lifecycle
plan.ticket.opened       { mapId; ticketId; type: TicketType; title: string;
                           question: string; blockedBy: string[] }
plan.ticket.claimed      { mapId; ticketId; owner: string }
plan.ticket.resolved     { mapId; ticketId; answer: string; assetRefs?: string[] }
plan.ticket.closed       { mapId; ticketId; reason: "out_of_scope" | "invalidated"; why? }

type TicketType = "research" | "prototype" | "grilling" | "task" | "decision";
```

Resolution is its own event (`plan.ticket.resolved`, carrying the answer); a close
records only `out_of_scope` or `invalidated`. Both settling events **fail closed**:
a resolve with no answer, or a close with no legal reason (a torn or malformed
receipt), leaves the ticket open and visible rather than settling it into an empty
gist or an invisible sink it could never leave. Each sidecar row carries its own
`id`, `type`, `timestamp`, and authoring `sessionId` (the claim owner); assets
created while resolving a ticket are referenced by `assetRefs`, never inlined.

### 2. Projection (`plan.map.state.get`)

A pure rebuild over the receipt stream for a `mapId`, mirroring the goal builder.
The state holds the tickets once, in open order, and derives every view — frontier,
decisions, blocked, claimed, out-of-scope, invalidated — as a pure selector over that
one list, so no materialized view can drift from the tickets it summarizes:

```typescript
interface PlanMapState {
  schema: typeof PLAN_MAP_SCHEMA; // "brewva.plan-map.v1"
  mapId: string;
  destination: string;
  notes: string;
  tickets: PlanTicket[]; // every ticket in open order; the views below are selectors over it
  notYetSpecified: PlanFogPatch[]; // Phase 2 fog; empty until plan.fog.recorded lands
  createdAt: number;
  updatedAt: number;
}

// Pure selectors over PlanMapState.tickets — surfaces render ticket titles, never ids:
planMapFrontier(state); // open ∧ unblocked ∧ unclaimed — the takeable edge
planMapBlocked(state); // open ∧ unclaimed ∧ still waiting on an open blocker
planMapClaimed(state); // open ∧ claimed — carries claimedBy
planMapDecisions(state); // closeReason === "resolved" — the route walked, carrying the answer
planMapOutOfScope(state); // closeReason === "out_of_scope" — recorded, never on the route
planMapInvalidated(state); // closeReason === "invalidated" — settled, off both the route and the scope ledger
```

The projection is deterministic: same receipts → same state. It renders titles, not
ids, and it is the _only_ read path; there is no mutable map object. Keeping the
tickets raw and deriving the views — rather than materializing `decisions` /
`frontier` / … onto the state — is what leaves a duplicate or replayed receipt suffix
no stale view to strand.

### 3. Managed tools (capability-scoped, planning-only)

Mirroring `get_goal`/`update_goal`, all read/planning, none effectful. Ten tools ship,
gated behind the opt-in `planning.mapEnabled` config flag (default off):
`create_plan_map(mapId, destination, notes?)` (once per effort),
`get_plan_map(mapId)` (the low-res projection; explicit-pull),
`open_plan_ticket` / `resolve_plan_ticket` / `close_plan_ticket` (out-of-scope or
invalidated), `claim_plan_ticket` (first-claim-in-file-order-wins; omit the ticketId to
take the first frontier ticket) / `unclaim_plan_ticket` (any session may release a
claim, so a crashed owner's ticket is recoverable), `rescope_plan_ticket` (re-frame an
open ticket in place, keeping its id and inbound blocking edges), and
`record_fog` / `graduate_fog` (park an unsharp question, then graduate the patch into
the fresh tickets it became — the graduation lineage is projected). A
`plan-map-plan-not-execute` fitness asserts every planMap-capability tool stays
planning-only (axiom 18).

Create-then-wire is two steps (a ticket needs an id before a sibling can block on
it), so `open_plan_ticket`'s result carries the new id and `blockedBy` edges are set
in a second `open` — the same shape `wayfinder` uses. The controller validates
`blockedBy` at open time (rejecting self-reference and unknown blockers), so the
fold's lenient dangling handling never has to hide a wiring error.

### 4. Command surface

`/map` interactive + owner-gated channel command, sharing the `/goal` command
pipeline and ACL. Each subcommand names the map explicitly (the `mapId` is the
effort's key), so both surfaces stay stateless — there is no per-surface "active
map" pointer that could drift from, or outlive, the durable cross-session log:
`/map chart <mapId> <destination>`, `/map show <mapId>`,
`/map take <mapId> [ticketId]` (claims the first frontier ticket when the id is
omitted), `/map resolve <mapId> <ticketId> <answer>`. The command is a thin wrapper
over the same `planMap` capability the managed tools expose; the model still does the
charting work — running `office-hours`/`strategy` to seed the frontier and the fog —
through those tools. An implicit active-map pointer and a `/map list` discovery
surface are deferred (Phase 2.5).

### 5. Durability

The map is an **effort-scoped durable sidecar**, decided during Phase 0 — not a
slice of the session tape. Each map is one append-only log at
`<workspaceRoot>/.brewva/planning/<encodeURIComponent(mapId)>.jsonl`, anchored to
`runtime.identity.workspaceRoot` exactly as the tape root is, and written with the
same crash-safe primitives from `@brewva/brewva-std/node/fs` — `appendFileDurable`
(atomic `O_APPEND`, fsync per record) for writes and the read-only `scanAppendOnly`
for reads. A multi-writer log cannot repair a torn tail by truncating without
racing a concurrent durable append, so reads **never mutate the file**: a torn
(power-loss) or malformed line is skipped, never truncated. The session tape is
rejected because it is session-scoped: a map only one session can see defeats the
cross-session premise, and putting `plan.*` on the session tape would widen its
identity (axiom 14) the way the steering-inbox decision declined to widen the WAL.
The controller re-reads the log per operation (no authoritative in-memory cache),
so concurrent sessions observe each other's appends; claim exclusion is
first-claim-in-file-order-wins. The map inherits the crash-safe (not yet
power-safe) posture of those primitives; power-safety is tracked in Open Questions.

## How To Implement

### Phase 0: Boundary confirmation (done)

Confirmed against the real `goal.*` vertical:

- The pure-fold pattern generalizes: `foldGoalEvents` is a pure reducer in the
  vocabulary and `goal.state.get` rebuilds from it — `foldPlanMapEvents` mirrors
  this, keyed by `mapId` (multiple concurrent maps) instead of one goal per session.
- The substrate is the effort-scoped sidecar (§5), reusing the steering-inbox
  primitives; `HostedRuntimeOpsContext` exposes `runtime.identity.workspaceRoot`,
  so the controller resolves the log path with no new plumbing.
- The model surface mirrors `goal`: a `planMap` capability namespace in
  `contracts/runtime.ts`, a runtime-ops builder, and capability-scoped managed
  tools single-sourced through `MANAGED_BREWVA_TOOL_METADATA_BY_NAME`.

### Phase 1: MVP — durable map + read projection (landed)

- Landed: the `plan.map.created` / `.destination.set` / `.notes.set` and
  `plan.ticket.opened` / `.resolved` / `.closed` events, the deterministic
  `foldPlanMapEvents` projection with the frontier query, the effort-scoped
  multi-writer sidecar store, the `planMap` runtime-ops capability, and the
  `create_plan_map` / `get_plan_map` / `open_plan_ticket` / `resolve_plan_ticket` /
  `close_plan_ticket` tools. No claim, no fog graduation yet.
- Fitness (green): projection determinism (same receipts → same state); the
  frontier is exactly open ∧ unblocked; a resolve/close records a receipt and no
  effect.

### Phase 2: Concurrency + fog (landed)

- Landed: `plan.ticket.claimed` (the lock, first-claim-in-file-order-wins, with a
  `claim_lost` result for a raced loser); the fog family `plan.fog.recorded` /
  `.graduated` with the `record_fog` / `graduate_fog` tools; in-place re-framing
  `plan.ticket.rescoped` + `rescope_plan_ticket`; and the `/map` interactive +
  owner-gated channel command grammar (explicit `mapId`, sharing the `/goal`
  pipeline).
- Tests (green): two sessions cannot both hold a claim on one ticket; a graduated fog
  patch leaves the Not-yet-specified list and appears only as its new tickets; an
  out-of-scope ticket is closed, absent from the frontier, and never in Decisions; a
  rescope re-frames an open ticket in place but is ignored on a settled one; the
  `/map` grammar parses, routes to the `planMap` capability, and is owner-gated.
- Deferred to Phase 2.5: an implicit active-map pointer and a `/map list` discovery
  surface.

### Phase 3: Effectiveness measurement (the promotion gate)

- Instrument: how often is a map created, how many sessions resolve its tickets,
  how large are the efforts (context windows spanned)? Does externalizing the plan
  measurably reduce ticket-session compaction pressure vs a compaction-only
  baseline?
- Gate: if real efforts rarely exceed one context window, or the sidecar-plus-hand-
  maintained-markdown MVP already suffices without the projection machinery, the
  heavy path does not promote.

## Validation Signals

- Determinism fitness: `plan.map.state.get` is a pure function of its receipts.
- Frontier fitness: the frontier is exactly `open ∧ all blockers closed ∧
unclaimed` — property-tested against generated ticket graphs.
- Claim-exclusion: concurrent claims on one ticket resolve to a single owner; the
  loser sees `claim_lost` (covered by a test that injects a competing claim earlier in
  file order to reproduce the file-order race), and an `unclaim` returns a stranded
  claim to the frontier for another session.
- Plan-not-execute fitness (axiom 18): no `plan.*` tool is registered with an
  effect capability; resolving a ticket produces no world effect.
- Explicit-pull fitness (axiom 1): the map is never in the auto-materialized
  context set; loading it is an explicit tool call.
- Graduation: a graduated fog patch is removed from Not-yet-specified and its lineage
  (which tickets it became) is projected; out-of-scope closes never enter Decisions.
- `bun run check` and the full `bun test` suite both green.

## Surface Budget

| Surface                               | Before | After | Notes                                                                                                             |
| ------------------------------------- | -----: | ----: | ----------------------------------------------------------------------------------------------------------------- |
| Required authored fields              |      0 |     0 | Charting a map is opt-in; nothing is required of an author who never uses it.                                     |
| Optional authored fields              |      0 |    +1 | `planning.mapEnabled` (implemented, default off): the tools are opt-in, off the prompt budget until enabled.      |
| Author-facing concepts                |      0 |    +1 | The map (destination / frontier / fog / out-of-scope). One concept, deliberately mirroring `/goal`.               |
| Persisted formats                     |      0 |    +1 | The `brewva.plan-map.v1` event family.                                                                            |
| Inspect surfaces                      |      0 |    +1 | The map projection mounts under the existing shared inspect host.                                                 |
| Public tools                          |      0 |   +10 | `create`/`get`/`open`/`claim`/`unclaim`/`resolve`/`close`/`rescope` + `record_fog`/`graduate_fog`, planning-only. |
| Routing/control-plane decision points |      0 |    +1 | The `/map` command surface; no auto-dispatch decision is added.                                                   |

Net new required authored surface: **0**. Debt owner: runtime/gateway maintainers.
Re-evaluation trigger: the Phase 3 gate — if maps are rarely created or the MVP
sidecar suffices, the projection + concurrency machinery is reverted, not toggled.

## Promotion Criteria

Move to `docs/research/decisions/` only after:

- [x] Phase 1 (map + projection + frontier) implemented and green — vocabulary,
      the multi-writer sidecar store, the `planMap` runtime-ops capability, and the
      five managed tools land with `bun run check` and `bun run test:ci` green.
- [x] Phase 2 (claim + fog graduation + rescope + `/map`) implemented and green —
      the fog family (`record_fog` / `graduate_fog`), `rescope_plan_ticket`, and the
      `/map` interactive + owner-gated channel command all land with `bun run check`
      and `bun run test:ci` green.
  - gate: `bun test test/fitness/plan-map-plan-not-execute.fitness.test.ts`
- [ ] A measured cross-session demand signal: real efforts span multiple sessions
      often enough that the durable map beats a compaction-only baseline — needs
      production telemetry (Phase 3), not code alone.
- [ ] Stable docs (`docs/reference/runtime.md` planning-map contract and the
      interactive-command surface) carry the map — written at promotion, not before.

Status: 2 of 4 met — NOT promotable. Phases 1 and 2 (the code MVP) have landed and
are green. The two open criteria are both beyond code: Phase 3 needs production demand
telemetry, and the stable-docs contract is written at promotion (the reference carries
accepted contracts, not active RFCs). The single largest risk to promotion is demand:
brewva's compaction leg keeps improving, and a strong model plus compaction may cover
more oversized-but-not-foggy work than expected. The map earns its weight only where
the plan is both **large and foggy**.

Validation note (2026-07-12): an RFC-validation pass looked for the demand signal
in the available tape corpus (8 ad-hoc sessions across three models + the five
self-eval fixtures) and found **zero** `plan.map.*` / ticket activity. This is
**not** evidence of absent demand: `planning.mapEnabled` defaults off, so the tools
were never surfaced in those sessions — the zero measures "not enabled," not "not
wanted." The Phase 3 gate is unchanged and unmeetable from local runs; it needs
production telemetry with the feature enabled across real multi-session efforts.
Criterion count stays 2 of 4 — NOT promotable.

## Open Questions

Resolved during Phase 0:

- **MVP floor / effort scope.** The map is the full event-family + fold, not a
  hand-maintained markdown file — the durable, concurrently-editable,
  frontier-queryable behavior is the point, and the vocabulary fold is small
  (~250 lines). It anchors to a repo-scoped `mapId` log under
  `<workspaceRoot>/.brewva/planning/`; a later session opens it by `mapId`, and a
  `/map list` discovery surface is Phase 2.

Still open:

- **Claim liveness beyond manual `unclaim`.** An open `unclaim` (any session may
  release a claim) now recovers a stranded ticket from a crashed or abandoned session,
  so a claim is no longer a permanent lock. What remains is whether to add _automatic_
  staleness — a claim TTL or a stale-steal that returns a long-idle claim to the
  frontier without a human noticing — which needs a fold-visible clock policy and a
  tunable threshold, or whether manual `unclaim` is enough for the map's cadence.
- **Power-safety.** `appendFileDurable` fsyncs each append and `loadAppendOnly`
  truncates a torn tail on load, so the map is stronger than transient tape
  already. The remaining gap is atomic-rename durability of the whole log under a
  mid-append power loss — does the map force closing the shared substrate
  power-safety gap, or accept it as shared debt?
- **HITL vs AFK enforcement.** `grilling`/`prototype` tickets are human-in-the-loop:
  the agent must not answer the human's side of them (a grilling session that
  self-answers has broken the ticket). This is the same failure the
  authorship-taints-verification candidate axiom names for verification. Should the
  map record a `hitl` flag and refuse an agent-only `resolve` on it, or stay
  advisory?

## Related Docs

- `docs/research/decisions/goal-control-plane.md`
- `docs/research/decisions/durable-steering-inbox.md`
- `docs/research/decisions/session-index-read-model-engine.md`
- `docs/research/active/rfc-pre-compaction-deterministic-prune.md`
- `docs/architecture/design-axioms.md`
