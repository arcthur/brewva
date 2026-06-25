# RFC: Transcript As A Single Ordered Truth Source

## Metadata

- Status: active
- Implementation state: landed (the all-in-wire-fold feat plus a review
  hardening pass). Custom is now a `custom.message` wire frame emitted at the
  gateway origin (`runHostedRuntimeTurnAdapter` via the unified
  `HOSTED_RUNTIME_TURN_PRELUDE`); `refreshFromWireFold` is a wholesale
  `replaceMessages(snapshot)` plus a CLI-only rewind overlay; the projector
  patches this RFC retires (`#customTurnIdById`, `snapshotProvidesUser`, the
  interleave loop, `#fallbackEntrySequence`, `currentWireTurnId`) are deleted,
  subsuming the predecessor multi-turn-ordering fix. Promotion-eligible (all
  criteria met); pending only a real-TUI dogfood of custom display timing.
- Owner: CLI shell / wire-fold maintainers
- Last reviewed: `2026-06-25`
- Depends on:
  - `packages/brewva-cli/src/shell/domain/cockpit/wire-fold.ts` (folded
    transcript projection)
  - `packages/brewva-cli/src/shell/projectors/transcript-projector.ts`
    (`refreshFromWireFold`, free-floating message reconciliation)
- Promotion target:
  - `docs/reference/working-projection.md`
  - `docs/reference/events/README.md`

## Problem Statement

The CLI transcript has **two data sources** that must be merged on every live
turn:

- **Optimistic free-floating messages** — appended immediately for feedback:
  the user prompt (`session-handler.ts`, id `user:<ts>`) the moment it is
  submitted, and custom messages (skill SkillCards) when a `message_end` with
  `role: "custom"` arrives. These exist so the user sees input/skill activity
  without waiting for a wire round-trip.
- **Wire-fold authoritative projection** — the folded, de-duplicated,
  recovery-correct truth for assistant streaming and tool execution, exposed as
  `snapshot.transcriptMessages`.

`refreshFromWireFold` merges them with **two-segment concatenation**:
`[all non-wire] + [all wire]`. That assumes every non-wire message belongs ahead
of every wire message — a **single-turn mental model**. Across multiple turns it
breaks: every user prompt is hoisted to the front, so a second turn's prompt
lands before the first turn's answer (`[user1, user2, assistant1, assistant2]`).

The user-reported symptom (second prompt ordered wrong), the custom-message
hoist (skill SkillCards at the front), and the still-unfixed rewind-marker and
seed-custom hoist are **all the same root cause**. The current projector fixes
patch them per message type:

- user prompts → projected into wire-fold via `turn.input`, free-floating copy
  dropped under a guard;
- custom messages → attributed to a turn id and spliced in after that turn's
  user row.

This is whack-a-mole. Each new injected message type needs another special case,
and the merge strategy itself — not any single message type — is the defect.

## Scope Boundaries

In scope:

- The **ordering and identity** of live transcript messages projected into the
  CLI shell from wire-fold.
- Retiring the per-type reconciliation patches in `refreshFromWireFold`.

Out of scope (must not change):

- Persistence. The session `custom_message` entry and tape remain the durable
  record; seed rebuild (`buildSeedTranscriptMessages` / `refreshFromSession`)
  stays the authority for historical transcript order.
- LLM context. Custom messages keep `excludeFromContext: true`; making custom a
  wire frame is a **display** concern only and must not feed provider context.
- Runtime wire-frame semantics for `turn.input` / `assistant.delta` / `tool.*`.
- Recovery / replay / rewind transaction ownership.

## Why

A single ordered truth source is the only way this stops being whack-a-mole.
Today the order is a function of two sources and a hand-written merge; the merge
encodes a false invariant ("non-wire precedes wire"). When wire-fold already
projects user, assistant, and tool in correct turn order, the cheapest correct
design is to let it project **everything turn-scoped** and let
`refreshFromWireFold` degrade to `replaceMessages(snapshot)`. Free-floating
messages become pure optimistic placeholders, reconciled by wholesale
replacement rather than by type-specific splicing.

This also collapses custom's current **dual path** (a `message_end` event for
display plus a projector-side turn attribution) into a **single** wire-frame
path, which is the deeper reason the projector patch never felt principled.

## Architectural Positions

1. **Wire-fold `snapshot.transcriptMessages` is the single ordered truth source**
   for the live transcript. `refreshFromWireFold` becomes
   `replaceMessages(snapshot)` plus CLI-only overlays (below).
2. **Every turn-scoped message enters the snapshot through a wire frame.** user
   (`turn.input`), assistant (`assistant.delta`), tool (`tool.*`) already do;
   custom gains a `custom.message` frame.
3. **Custom is a member of the turn event stream**, injected at
   `before_agent_start`, semantically after the user row and before the
   assistant answer. It should be a frame from where it is produced, not patched
   in at the CLI projector.
4. **Free-floating messages are optimistic placeholders.** The user prompt
   renders instantly on submit (id `user:<ts>`) and is replaced wholesale when
   the authoritative snapshot arrives; the replacement is seamless (same visible
   text), so instant feedback is never lost and nothing flickers position.
   As landed, **custom has no optimistic placeholder** — it originates only from
   the gateway `custom.message` frame (there is no CLI-edge `message_end` inject
   point any more), so it renders when its frame folds in. This is strictly
   simpler than a placeholder + reconcile and removes any custom double-render
   risk.
5. **Rewind markers are a CLI-only overlay**, not a wire frame. `setRewindMarker`
   is a local tree-rewind affordance with no session/wire identity; it stays an
   explicit overlay appended at the tail, applied after the snapshot replace.
6. **Persistence is unchanged.** The durable `custom_message` entry and seed
   rebuild path are untouched; the wire frame is the live-display projection
   only, mirroring how assistant/tool already carry both a durable entry and a
   live frame.

## Shared Projection Discipline (inherited)

This is a projection-bearing note and inherits `docs/research/active/README.md`'s
discipline. The transcript projection stays deterministic from wire frames and
declared read-model evidence, is rebuildable (seed path) and never becomes
replay truth, does not widen kernel/capability/source/adoption authority, reuses
existing redaction, and fails closed. RFC-specific invariant added on top: the
live transcript order is a pure function of the ordered wire-frame stream plus
the CLI rewind overlay — no second ordering authority.

## Source Anchors

- `packages/brewva-cli/src/shell/projectors/transcript-projector.ts`
  — `refreshFromWireFold` (target of the `replace` degrade), the free-floating
  reconciliation and `#customTurnIdById` patch to retire, `setRewindMarker`.
- `packages/brewva-cli/src/shell/domain/cockpit/wire-fold.ts`
  — `applyFrame` (`turn.input` user projection model to copy for custom),
  `transcriptMessagesView` / `materializeDirtyAssistantSegments`,
  `transcript*MessageId` id helpers.
- `packages/brewva-cli/src/shell/ports/session-adapter.ts`
  — `onFrame` sink (`liveSessionWireFrames.remember` + `cockpitWireFold.remember`
  - `emitRuntimeTurnSessionFrame`), the wireFold-mode prompt path, the session
    listener `subscribe` that delivers custom `message_end` events.
- `packages/brewva-gateway/src/hosted/internal/session/managed-agent/event-bridge.ts`
  — `appendPassiveCustomMessage` (custom message origin; no turnId / frame-sink).
- `packages/brewva-gateway/src/hosted/internal/session/managed-agent/session-prompt-dispatch.ts`
  — `prepareManagedPromptDispatch` (consumes `beforeStart.messages`; deps lack a
  frame-sink).
- `packages/brewva-gateway/src/hosted/internal/turn/session-mux/runtime-frame-projection.ts`
  — runtime `TurnFrame` → `SessionWireFrame` projection (only sees runtime
  frames, not host-injected custom).
- `packages/brewva-vocabulary/src/internal/wire.ts` +
  `wire-validation.ts` — `SessionWireFrame` union (no custom type today) and its
  validator.

## Architecture Proposal

1. **New `custom.message` `SessionWireFrame`** (`wire.ts` + `wire-validation.ts`):
   `{ schema, sessionId, turnId, frameId, ts, source, durability, customType,
content, display }`. Carries only display-bearing fields; never carries
   provider-context payload. `turnId` and `customType` are required non-empty
   (a turn-less custom cannot be ordered, so it fails validation closed).
2. **Custom frame production — gateway origin (decided; see Spike Findings).**
   Emit `custom.message` from `runHostedRuntimeTurnAdapter` right after the prelude
   returns ready: that single seam owns `onFrame` + `turnId`, and both the legacy
   `session.prompt` and wireFold `runHostedPromptTurn` flows funnel through it (one
   prelude, one consumption call), so the frame rides a single stream with no
   arrival-order race. The injected custom messages are surfaced by extending the
   prelude result (filtered by `role: "custom"`). The CLI-edge alternative
   (constructing the frame from the `message_end` listener) was rejected: it keeps
   custom on two streams with a `turn.input` arrival-order dependency.
3. **Wire-fold `applyFrame` handles `custom.message`:** flush pending assistant
   segments first (so later-turn customs cannot precede an earlier-turn answer),
   then `upsertTranscriptMessage(turnId, customMessage)` so the snapshot is a
   complete, correctly ordered `user → custom → assistant → tool` per turn.
4. **`refreshFromWireFold` degrades to replace:**
   `replaceMessages([...snapshot.transcriptMessages, ...rewindMarker])`. Delete
   the two-segment concatenation, `snapshotProvidesUser` guard, the custom
   interleave loop, `#customTurnIdById`, `currentWireTurnId`, and the
   `#fallbackEntrySequence` workaround — all subsumed by the single source.
5. **Free-floating optimistic placeholders** remain for instant feedback (user
   on submit, custom on inject) and are replaced wholesale by the next snapshot.
   The placeholder must match the authoritative text so replacement is seamless.

## Workstreams

1. **Design spike — done.** Pinned the custom-injection consumption point
   (`HOSTED_RUNTIME_TURN_PRELUDE` via `runHostedRuntimeTurnAdapter`, shared by
   both flows) and decided gateway origin. See Spike Findings.
2. **Vocabulary — done.** `custom.message` frame type (live/cache) + validator +
   round-trip coverage.
3. **Wire-fold projection — done.** `applyFrame` custom handling, the
   before-`turn.input` hold buffer, and the commit-survival fix; ordering tests
   cover `user → custom → assistant`, early-arrival, and post-commit.
4. **Frame production — done.** `emitRuntimeCustomMessageFrames` in the
   session-mux, one frame per `display` custom with the turn id; `display:false`
   context injections are dropped.
5. **Projector degrade — done.** `refreshFromWireFold` is now a replace + rewind
   overlay; the retired patches are deleted; the user optimistic placeholder is
   kept (custom has none). Rewind-marker-past-a-custom ordering is test-covered.
6. **Validation — done; dogfood pending.** `bun run check` + full `bun test`
   green (2855 pass); real-TUI dogfood of custom display timing is the one
   remaining human-in-loop check.

Each workstream landed behind a green `bun run check` + full `bun test`.

## Failure Semantics

If a `custom.message` frame is malformed or its turn id cannot be resolved, the
projection fails closed: the custom row is omitted from the ordered snapshot
rather than hoisted to an arbitrary position, and the optimistic placeholder (if
still present) is what the user sees. No silent re-ordering of unrelated turns.

## Validation Signals

- Wire-fold unit: a multi-turn frame sequence projects
  `[user1, custom1, assistant1, user2, custom2, assistant2]`.
- Projector unit: `refreshFromWireFold` returns exactly
  `snapshot.transcriptMessages` (+ rewind overlay) with no per-type branching.
- Regression: the original `[user1, user2, assistant1]` hoist cannot recur; seed
  custom and rewind markers sit in their correct positions.
- Dogfood: real TUI, several turns with skill triggers and a rewind, confirming
  ordering and that instant feedback never flickers position.

## Promotion Criteria

Convert to `docs/research/decisions/` when: custom is a wire frame on the chosen
site, `refreshFromWireFold` is a pure replace, the projector patches
(`#customTurnIdById`, `snapshotProvidesUser`, interleave loop) are deleted,
multi-turn + custom + rewind ordering is test-covered, and both gates are green.

## Alternatives Considered

- **Projector per-type patches (the predecessor multi-turn-ordering fix).** Correct display today
  but whack-a-mole: two mechanisms (user in wire-fold, custom in projector),
  rewind/seed-custom uncovered, and a new patch per future injected type. This
  RFC retires it.
- **CLI-edge frame production.** Reaches a single truth source without touching
  the gateway, but keeps custom on two streams with an arrival-order dependency;
  less principled than gateway origin though materially cheaper.
- **Keep two sources, sort by a global sequence key.** Would require every
  message to carry a comparable monotonic key across both sources; more
  invasive than letting wire-fold own ordering and offers no extra benefit.

## Risks

- **Dual-mode divergence.** Custom injection differs between legacy
  `session.prompt` and wireFold `runHostedPromptTurn`; the spike must confirm one
  consumption point or handle both.
- **Arrival-order race (CLI-edge only).** Custom `message_end` must not be
  processed before the turn's `turn.input` frame, or the turn id is wrong.
  Gateway origin avoids this.
- **Instant-feedback seam.** Optimistic placeholder text must match the
  authoritative frame text or replacement will visibly flicker; attachment-only
  prompts (limitation 1) make user text differ from `turn.input.promptText`.
- **Persistence/display split.** The wire frame is display-only; the durable
  `custom_message` entry and `excludeFromContext` must stay intact.

## Spike Findings (`2026-06-25`)

Open questions 1 and 2 are resolved; the decision is **gateway origin**.

- **Unified consumption point (Q1).** Custom messages are injected by
  `HOSTED_RUNTIME_TURN_PRELUDE` (`session.ts`), which calls
  `prepareManagedPromptDispatch` → `appendPassiveCustomMessage` and stores the
  prepared messages on `#runtimeTurnContext`. The prelude is invoked once, by
  `resolveRuntimePrompt` in `runtime-turn-adapter.ts` (the
  `runHostedRuntimeTurnAdapter` path), which **both** legacy `session.prompt` and
  wireFold `runHostedPromptTurn` flow through (both run `runHostedTurnEnvelope` →
  runtime turn). There is no dual-mode fork: one prelude, one consumption call.
- **onFrame + turnId are co-located (Q2).** `runHostedRuntimeTurnAdapter` holds
  `input.onFrame` and `input.turnId` and sees the prelude result
  (`prompt.prelude`). The `custom.message` frame can be emitted right after the
  prelude returns ready, from a single gateway seam — no CLI-edge dual stream and
  no arrival-order race. **Decision: gateway origin.**
- **Custom messages source.** The prelude result currently surfaces only
  `promptText` / `promptContent`. Cleanest implementation: extend the prelude
  result to return the injected custom messages (already on
  `#runtimeTurnContext.messages`, filterable by `role: "custom"`) rather than
  re-reading `HOSTED_RUNTIME_TURN_CONTEXT()` from the adapter.

## Remaining Open Questions

1. Should the optimistic user placeholder converge on the same text source as
   `turn.input.promptText` to kill the attachment-only seam (limitation 1) at the
   same time? **Still open** — limitation 1 is untouched by this change.
2. ~~Does any consumer rely on the current `custom:end:<ts>` free-floating id
   shape once custom is a wire frame?~~ **Resolved (no).** The wire-fold
   transcript keys custom rows by `wire:<sessionId>:<turnId>:custom:<customType>`;
   the projector's `message_end` custom turn-id tracking is removed and the
   optimistic placeholder id reverts to the plain `${role}:end:<ts>` shape. No
   consumer depends on the old shape for ordering.

## Surface Budget

Vocabulary: one frame type + validator. Wire-fold: one `applyFrame` case + id
helper. Projector: net **deletion** (`refreshFromWireFold` shrinks; patches
removed). Frame production: one site (gateway origin) or one CLI listener branch
(edge). No new inspect surface, no new authority, no provider-context change.
