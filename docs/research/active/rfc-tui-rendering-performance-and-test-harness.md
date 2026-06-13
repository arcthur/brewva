# RFC: TUI Rendering Performance And Test Harness

## Metadata

- Status: active
- Implementation state: WS1-WS6 implemented and merged to main (including a
  seven-angle review pass with fixes); promotion to a decision record awaits
  interactive smoke verification under a live task
- Owner: CLI shell maintainers
- Last reviewed: `2026-06-13`
- Promotion target:
  - `docs/architecture/system-architecture.md`
  - `docs/reference/commands.md`
  - `test/README.md`

## Problem Statement

The interactive TUI degrades badly while a task is streaming: token output is
not smooth, transcript scrolling stutters, and keystrokes in the composer lag
noticeably. The symptoms are not caused by OpenTUI itself. They are caused by
how the shell state architecture feeds OpenTUI: an immutable
snapshot-and-subscribe view model is rebuilt and structurally diffed on every
emit, per-token projector work is linear in transcript size, and the composer
triggers synchronous filesystem walks on keystrokes. All of this shares one
single-threaded event loop with layout and painting, so render pressure
directly starves input.

A second, structural problem blocks the fix: the team relies on static
analysis because rendering performance has no measurement loop. Without a
deterministic way to replay realistic sessions through the renderer and assert
work counts, every architectural change to the hot path is a leap of faith.
This RFC therefore treats the test harness as a deliverable of equal rank with
the optimizations, and sequences it first.

## Scope Boundaries

In scope:

- streaming text accumulation in the transcript projector
- view model projection and the snapshot/reconcile boundary in
  `useShellState`
- composer completion refresh policy and the workspace completion source
- derived render computations in transcript components (line splitting,
  block classification)
- cockpit progress projection cadence during streaming
- a clock seam in `CliShellRuntime` for deterministic timer testing
- a session-replay performance harness and count-based fitness invariants

Out of scope:

- replacing OpenTUI or the Solid reconciler
- changing the renderer-contract port surface beyond what the projection
  optimizations require
- public ACP/MCP wire changes
- transcript retention policy redesign (the existing ~100-row window stays)
- multi-threaded or worker-based rendering

## Findings

All findings were confirmed by reading the code paths end to end. Line
references are against the branch point of this worktree.

### F1. Full view-model clone plus full reconcile diff per emit (critical)

`projectShellViewModel` (`packages/brewva-cli/src/shell/domain/view-model.ts`)
copies every branch of the view state into fresh objects and arrays on every
`getViewState()` call: `[...state.transcript.messages]`, notifications, queue,
composer parts, status entries, focus stack, overlay queue, and more. The
renderer subscribes via `useShellState`
(`packages/brewva-cli/runtime/shell/utils.ts`) and applies
`setState(reconcile(runtime.getViewState()))` on every change notification.

Because every branch reference is freshly allocated, `reconcile` can never
short-circuit on reference equality. Each emit pays a structural diff of the
entire state tree, and memos that depend on broad paths (for example
`state.transcript.messages` feeding `transcriptRows` in
`packages/brewva-cli/runtime/shell/app.tsx`) re-run on every frame even
when their inputs are semantically unchanged. The Elm-style
snapshot-and-subscribe contract defeats Solid's fine-grained reactivity and
turns every 16ms streaming flush into an O(state-size) walk.

### F2. Per-token projector work is O(n + m) (critical)

For each text delta, the transcript projector
(`packages/brewva-cli/src/shell/projectors/transcript-projector.ts`)
performs `findMessage(id)` (linear scan over the message array), `readText()`
(filter/map/join over all parts to rebuild the accumulated text from scratch),
and `upsertMessage` (spread-copy of the whole message array). A 1000-token
response performs roughly 1000 linear scans, 1000 full-text rebuilds, and 1000
array copies. Streaming accumulation is implemented through immutable state
semantics on the hottest path in the system.

Both projection modes are affected. The default `legacySessionEvents` mode
(`packages/brewva-cli/src/shell/ports/session-adapter.ts`) runs the path
above once per queued event inside a flush — the 16ms coalescing bounds the
render cadence but not the per-event projection cost, and text deltas are not
merged before projection. The `wireFold` mode is better (one
`refreshFromWireFold` per flush) but still upserts a full message object into
the fold store per delta (`src/shell/domain/cockpit/wire-fold.ts:603`) and
filters the full transcript array on every flush
(`src/shell/projectors/transcript-projector.ts:128`).

### F3. Completion refresh on every keystroke with synchronous filesystem I/O (critical)

`commit` defaults to `refreshCompletions ?? true`
(`packages/brewva-cli/src/shell/controller/shell-runtime.ts`), so every
composer state commit schedules a completion refresh with no debounce. The
workspace completion source
(`packages/brewva-cli/src/shell/domain/completion-provider.ts`) walks the
working tree with `readdirSync` up to depth 4 and 500 entries, synchronously,
on the event loop. Combined with the semantic input queue
(`shell-runtime.ts:927`), which serializes keystroke handling behind the
previous handler, one slow refresh delays every subsequent keystroke. This is
the direct mechanism behind composer input lag.

### F4. Repeated derived string work in transcript components (high)

Transcript components re-derive line structure from full content strings on
every render: exec tool output (potentially 10-100KB) is re-split with
`split(/\r?\n/u)` per render
(`packages/brewva-cli/runtime/shell/transcript.tsx`), and the mermaid
fence classification regex re-scans the full growing text per token
(`transcript.tsx:99`, pattern in
`src/shell/domain/overlays/projectors/transcript-markdown.ts:76`). These live
inside `createMemo`, but the memo dependency is the growing string itself, so
the memo provides no amortization during streaming.

### F5. Cockpit progress re-projection every 100ms (medium)

During streaming, cockpit sync
(`packages/brewva-cli/src/shell/controller/cockpit-sync.ts`) rebuilds the
full cockpit projection on a 100ms timer, including cold-source reads
(`buildInspectReport`, work-card projection, runtime event queries). The work
is timer-driven rather than change-driven and shares the same event loop as
rendering and input.

### F6. Scroll synchronization feedback loop (critical)

`installScrollboxMetricObserver`
(`packages/brewva-cli/runtime/shell/app.tsx`) subscribes to the
renderer's per-frame `"frame"` event in addition to scrollbar `"change"`
events, re-checking the scroll snapshot on every frame (plus a microtask
double-check). Any snapshot change re-runs the scroll effect
(`app.tsx:484-534`). When the user has scrolled up while a response streams
(follow mode `scrolled`), content growth increases `scrollHeight` every
flush, so `currentOffset` drifts past the epsilon at `app.tsx:523` and the
effect emits a `surface.scrollSync` input. The handler
(`packages/brewva-cli/src/shell/controller/renderer-input-handler.ts`)
deduplicates with exact integer equality — no epsilon — so each one-row
growth commits, which emits a change, which runs the full projection and
reconcile, which produces a new frame, which fires the observer again. The
loop is self-sustaining for the entire scrolled-during-streaming window, and
every manual wheel tick also pays a full projection round trip. This is the
direct mechanism behind scroll lag, and it doubles total frame work while
active.

### F7. Stale composer write-back clobbers in-flight typing (critical)

The composer effect (`app.tsx:536`) imperatively applies
`node.setText`/`node.setCursor` whenever the composer state slice changes.
The textarea is intentionally ahead of runtime state: editor syncs are
debounced by 80ms and then serialized through the async semantic input
queue (`shell-runtime.ts:927`). When a composer-slice commit lands while the
user has typed further — a stale `editorSync` echo, a completion update, or
any composer mutation — the effect writes the older text and cursor back
into the textarea, dropping keystrokes and jumping the cursor. Under
streaming load the input queue drains slowly, so the staleness window
widens exactly when the user perceives input lag. Note the mechanism is the
echo race, not reconcile: `reconcile` preserves referentially equal leaves,
so pure transcript streaming does not re-run this effect by itself.

### F8. Streaming preview re-wraps the full text per update (high)

During streaming, transcript text does not go through the incremental
markdown path at all: `TranscriptTextBlockView` routes
`streamingPreview` content to `StreamingTextPreview`
(`packages/brewva-cli/runtime/shell/transcript.tsx`, used at
`transcript.tsx:110`), a plain `<text>` node receiving the full growing
string (re-trimmed per update). OpenTUI must re-measure and re-wrap the
entire block on every flush, so per-frame layout cost grows linearly with
the length of the in-flight response.

### What is already correct

These mechanisms were verified and should not be rebuilt:

- 16ms coalescing of high-frequency session events
  (`shell-runtime.ts:1027`) bounds emit frequency during streaming.
- Transcript retention windows the rendered rows to ~100
  (`runtime/shell/transcript-retention.ts`), so Yoga layout cost does not grow
  unboundedly with conversation length.
- The composer textarea uses OpenTUI's native edit buffer with an early-exit
  sync guard; large pastes collapse to a single summarized event.
- OpenTUI 0.2.16's `<markdown streaming>` performs incremental parsing (only
  the trailing block is reparsed). Claims that markdown reparses the full
  document per token are false. Note, however, that the streaming preview
  path bypasses markdown entirely (see F8), so this only helps once a
  message stabilizes.
- Node-side scroll application uses epsilon bounds
  (`setScrollTopIfChanged`), avoiding scroll-top thrashing — the feedback
  loop in F6 lives in the state write-back direction, not here.

### Claims reviewed and rejected

External review raised two claims that do not survive code reading and must
not drive the design:

- "Streaming accumulates O(totalCharacters^2) string copying." JS engines
  rope-optimize `segment.text += delta`, and message objects carry string
  references, not copies. The real costs are the per-delta array upserts
  (F2) and the per-frame full-text re-wrap (F8) — linear per frame, not
  quadratic in total.
- "Lowering the renderer to 30fps fixes the load." Halving the frame rate
  halves the symptom without touching the cause. After F1/F2/F6 are fixed,
  per-frame cost must fit a 16ms budget at 60fps; the frame rate is not the
  knob this RFC turns.

## Direction

Three principles order the work:

1. **Measurement before mutation.** No hot-path refactor lands without a
   replay benchmark baseline and count-based invariants that would catch a
   regression deterministically in CI.
2. **Pay per change, not per frame.** The renderer boundary must preserve
   reference identity for unchanged state branches so that Solid's reactivity
   does the minimal work it was designed for. Streaming accumulation must be
   O(1) per token, with immutability restored at flush boundaries rather than
   per delta.
3. **High-frequency state stays renderer-local.** Scroll position, in-flight
   streaming text, and composer text are render-rate concerns. They must not
   round-trip through the global domain store on every change; the domain
   store carries low-frequency control state (session, overlays, queue,
   follow-mode transitions) and receives high-frequency state only at
   stable boundaries.

The long-term target architecture is a dual-speed state channel: a control
store for low-frequency domain state consumed through the existing
projection contract, and a live render channel for the in-flight response
(chunk list materialized at most once per frame), tool progress, scroll
position, and focus, owned by the renderer and never re-entering the commit
path mid-stream. F6 (scroll write-back) and F7 (composer write-back) are
both violations of this principle, and WS2/WS4/WS6 below are incremental,
individually shippable steps toward it — not a wholesale rewrite.

The dual-speed target is no longer hypothetical: opencode's TUI (same
stack — OpenTUI + Solid + Bun) ships it in production. Its SSE event
handlers coalesce on a 16ms window and write directly into id-normalized
fine-grained Solid stores inside `batch()` (a token delta is one
`produce` append on `part[messageId]`), components subscribe to store
paths, and no snapshot/projection/reconcile boundary exists at all. If a
future benchmark shows the structural-sharing projection (WS4) still
paying too much, that is the proven endgame shape on this exact stack.

## Workstreams

### WS1: Deterministic performance harness (first, blocking)

The repository already contains most of the required pieces: 5000+ lines of
TUI tests run through `openTuiSolidTestRender`, `createFakeBundle()`
constructs `CliShellRuntime` without a real gateway, and
`test/helpers/events.ts` parses canonical tape JSONL. `@opentui/core/testing`
ships `ManualClock`, `captureCharFrame()`, `MockInput.typeText()`, and
`getNativeStats()`, none of which are currently used for performance work.

Deliverables:

- **Clock seam.** `CliShellRuntime` accepts an injectable timer/now source so
  the 16ms streaming flush, the 100ms cockpit cadence, and the composer
  debounce become controllable from tests with `ManualClock`. This is the only
  production refactor in WS1 and is behavior-preserving.
- **Replay benchmark.** A harness that feeds a recorded session tape (or a
  synthetic token stream of configurable rate and length) through
  `createFakeBundle` into the Solid test renderer, advancing the manual clock,
  and reports per-frame wall time plus `getNativeStats()`. Run on demand, not
  in PR gating; its job is before/after evidence for WS2-WS4.
- **Count-based fitness invariants** (deterministic, CI-safe; assert work
  counts, never milliseconds):
  - replaying N token deltas over T simulated milliseconds produces at most
    `ceil(T / 16)` change emissions;
  - a single token delta triggers at most one view-model projection and at
    most one message-array copy;
  - a single composer keystroke triggers zero synchronous `readdirSync` calls
    on the input path;
  - streaming content growth in `scrolled` follow mode produces zero
    `surface.scrollSync` commits (kills F6 and guards its return);
  - the textarea never receives `setText` with content older than the last
    simulated keystroke (kills F7 and guards its return);
  - frame snapshots (`captureCharFrame`) over a fixed fixture stream are
    stable, locking external behavior before internal refactors begin.

The benchmark runs with `gatherStats` enabled
(`packages/brewva-cli/runtime/internal-opentui-runtime.ts` currently
hard-disables it); the production default stays off.

### WS2: O(1) streaming accumulation in the projector

Maintain a mutable per-message-id accumulation buffer inside the transcript
projector. Token deltas append to the buffer in O(1); the immutable transcript
message is materialized only at flush boundaries (the existing 16ms cadence)
or at message end. `findMessage` linear scans on the delta path are replaced
with a map keyed by message id.

Within each flush, coalesce queued events before projecting: merge
consecutive text deltas per `(turnId, attemptId)` into one append, and keep
only the latest tool-execution update per `toolCallId` (latest-wins). This
bounds per-flush projection work by the number of distinct streams, not the
number of raw events, and applies to both projection modes. Eliminates F2
without changing the reducer contract or message shapes.

### WS3: Keystroke path hygiene

- Flip the `refreshCompletions` default to false; request refresh explicitly
  from the composer-text-changed path only while a trigger context (`/` or
  `@`) is active, with a debounce in the 100-150ms range.
- Make the workspace completion source asynchronous and cache directory
  listings between refreshes; the synchronous `readdirSync` walk must leave
  the keystroke path.
- Treat the textarea as uncontrolled while the user is editing: the composer
  effect writes text/cursor back into the node only for external sources —
  history navigation, completion acceptance, prefill, and submit-clear —
  guarded by an explicit marker (an `editorDirty` flag or a
  `composer.revision` counter), never as an echo of `editorSync`.
- Verify with the WS1 invariants that the input path performs no synchronous
  filesystem I/O and that no stale write-back reaches the textarea.

Resolves F3 and F7.

### WS4: Structural sharing across the projection boundary

Rework `projectShellViewModel` so unchanged branches keep their references:
either track per-branch dirty flags at commit time, or cache the previous
projection and reuse branch objects whose underlying state slice is
referentially unchanged. `reconcile` then short-circuits on untouched
branches, reducing the per-emit diff from O(state) to O(changed branches).
This keeps the ports/adapters boundary and the renderer contract intact.
Resolves F1 in its pragmatic form.

A deeper variant — routing the in-flight streaming text through a dedicated
fine-grained signal so the transcript array stays referentially stable during
streaming — is the full live-render channel of the dual-speed target. It
crosses the renderer-contract boundary and should only be attempted if WS2
plus WS4 leave measured frame cost above budget on the replay benchmark.

### WS5: Renderer-local scroll synchronization

Break the F6 feedback loop by making scroll position renderer-local:

- Drop the renderer `"frame"` subscription in
  `installScrollboxMetricObserver`; rely on scrollbar `"change"` events with
  a coarse fallback poll (100-200ms), not a per-frame check.
- In `live` follow mode, content growth is handled entirely by OpenTUI's
  `stickyScroll`; it must not write back to the runtime.
- Sync only follow-mode transitions (`live` <-> `scrolled`) and explicit
  navigation to the domain store; the continuously-drifting `scrollOffset`
  during streaming stays in the renderer.
- Where a write-back remains, round the offset and deduplicate with an
  epsilon in the handler
  (`renderer-input-handler.ts:67` currently uses exact equality), and guard
  programmatic scroll application so it is never re-ingested as user
  scrolling.

Resolves F6.

### WS6: Derived computation and streaming layout (after WS1 evidence)

- Render only a tail window of the in-flight response during streaming
  (bounded lines/bytes for the `StreamingTextPreview` block), switching to
  the full markdown rendering when the message stabilizes. Bounds F8's
  per-frame re-wrap cost to a constant.
- Cache line-split results for exec output keyed by content reference.
- Make transcript block classification incremental or cache it per part
  identity so the mermaid fence regex does not re-scan the full text per
  token.
- Move cockpit progress projection from timer-driven to change-driven, with
  cold-source caching between syncs.
- Scan for the live-row boundary from the tail in
  `splitRetainedTranscriptRows`
  (`runtime/shell/transcript-retention.ts:66` currently `findIndex` from the
  front).

Resolves F4, F5, F8. Sized by benchmark evidence; items here may be
unnecessary if earlier workstreams already restore the frame budget — the
tail-window change in particular alters visible behavior while scrolled up
during a stream and lands only with benchmark justification. (The shipped
tail window was later superseded by throttled streaming markdown; see the
2026-06-13 addendum.)

## Sequencing

1. WS1 (harness, clock seam, baseline capture) — everything else is gated on
   it.
2. WS2, WS3, and WS5 in any order; each is local, low-risk, and
   independently verifiable against the baseline. Together they remove the
   three self-inflicted feedback paths (per-token projection cost, keystroke
   I/O and stale write-back, scroll round trips).
3. WS4 with frame snapshots from WS1 as the behavior lock.
4. WS6 only where the benchmark still shows material cost.

## Implementation Notes (2026-06-12)

All workstreams are implemented in this branch. Mechanism deltas against the
plan, with reasons:

- **WS1.** The clock seam is `ShellClock`
  (`packages/brewva-cli/src/shell/domain/clock.ts`); the deterministic
  manual implementation is test infrastructure and lives in
  `test/helpers/manual-shell-clock.ts`. The seam drives the 16ms streaming
  flush, the status debounce, the completion-refresh debounce, and the
  100ms cockpit cadence. The replay
  harness lives in `test/helpers/shell-fixture.ts` and
  `test/helpers/shell-replay.ts`; the benchmark in
  `test/bench/tui-streaming.bench.ts` (`bun run bench:tui`). Invariants and
  the frame-snapshot lock live in
  `test/unit/cli/shell-streaming-invariants.unit.test.ts` and
  `test/unit/cli/opentui-shell-renderer-replay.unit.test.ts`.
- **WS2.** Implemented as flush-window coalescing
  (`packages/brewva-cli/src/shell/projectors/session-event-coalescing.ts`)
  plus an O(1) draft-text buffer in the projector and lazy assistant-segment
  materialization in the wire fold. One planned detail was dropped: replacing
  `findMessage` with an id-to-index map. The messages array is owned by the
  reducer and replaced externally, so a map cannot be maintained more cheaply
  than the scan it replaces; tail-first scanning achieves the same effect
  because streaming messages live at the tail.
- **WS3.** Commit-level policy: `refreshCompletions` defaults to false and
  auto-fires only when a commit changes composer text while a completion
  popup is open; the editor sync path opts in explicitly, debounced 120ms.
  The workspace source is cache-backed and asynchronous
  (stale-while-revalidate, `onEntriesUpdated` re-resolve); `resolve()` never
  touches the filesystem. Fixing this exposed a latent bug worth recording:
  completion state commits used `emitChange: false` and relied on the next
  keystroke's commit to repaint the popup — a one-keystroke popup lag that
  the detached debounced refresh made visible. Completion commits now emit,
  guarded by the handler's equality early-return.
- **WS4.** `createShellViewModelProjector`
  (`packages/brewva-cli/src/shell/domain/view-model.ts`) reuses previous
  branch projections when the underlying state slice is referentially
  unchanged; identical state returns the identical projection object.
- **WS5.** Landed as planned; the dead `surface.scroll` action was removed
  outright. The previous bottom-anchored scroll restore is gone: in scrolled
  mode the view is now top-anchored (native scrollbox behavior, matching
  terminal scrollback expectations) instead of being dragged toward new
  content.
- **WS6.** Initially shipped as a plain-text tail window; superseded by
  throttled streaming markdown after studying opencode (see the
  2026-06-13 addendum below).
  The exec line-split and mermaid classification items were resolved
  structurally by WS4 — branch sharing keeps memo dependencies referentially
  stable, and the classification memo is lazy and never evaluated during
  streaming preview. The reverse tail scan in `splitRetainedTranscriptRows`
  was REJECTED: streaming messages are not guaranteed to be contiguous at
  the tail (a tool message mid-transcript can re-enter streaming render
  mode), so an early-exit reverse scan would be incorrect, and the O(n) scan
  over a bounded retained window is negligible. Cockpit progress projection
  was left timer-throttled: it is already event-driven at the trigger and
  serves a cached cold source on the progress path, so the remaining cost is
  one in-memory projection per 100ms.

Benchmark evidence (M-series laptop, 100x36 terminal, 100-message history,
30k-char response in 4-char deltas at 1ms simulated cadence, `bun run
bench:tui -- --chars 30000 --history 100 --interval 1`):

- before: frame mean ~1.7ms, p95 ~2.9ms, max 12-17ms (spiking past the 16ms
  budget as the in-flight text grew)
- after WS6: frame mean 0.9-1.4ms, p95 ~2.5-2.9ms, max 4.1-4.6ms — worst
  case comfortably inside the budget and no longer growing with response
  length

The synthetic scenario underestimates production cost (trivial cockpit cold
source, no tool output, legacy projection mode), so the count-based
invariants — bounded emits, zero scroll-sync commits from content growth,
zero keystroke filesystem I/O, revision-guarded composer write-back — are
the primary regression gates, not the timings.

## Addendum (2026-06-13): opencode adoption pass

Three changes landed after studying opencode's TUI (same OpenTUI + Solid +
Bun stack, materially smoother in production):

- **Throttled streaming markdown replaces the plain-text tail window.**
  The in-flight response now renders through the native markdown
  renderable with `streaming` enabled — formatted output during
  streaming, not a degraded text preview. The content accessor is
  throttled to ~10Hz by `createStreamingText`
  (`packages/brewva-cli/runtime/shell/streaming-text.ts`), scheduled
  through the shell clock so replay tests drive it deterministically; the
  leading edge emits immediately, an unchanged value never consumes the
  window, and stabilization swaps to the finalized markdown branch. The
  tail-window module and its plain-text preview were removed. Benchmark
  (30k chars, 100-message history, 1ms cadence): paragraph-structured
  prose — frame p50 0.6ms, p95 3.4ms, max ~14ms, within budget; an
  adversarial single 30k-char paragraph (no block boundaries, so each
  10Hz flush re-lays-out the whole block) — p95 ~7.8ms, max ~18ms, at
  most one dropped frame per flush, the same exposure opencode accepts.
  `bun run bench:tui` covers both shapes (`--single-block`).
- **OpenTUI upgraded 0.2.16 -> 0.3.4.** The removed `testing` renderer
  flag is replaced by injected in-memory terminal streams in the smoke
  path; all 391 TUI tests including the frame snapshot pass unchanged,
  and the benchmark stays in the same band.
- **`ShellRendererController.getClock()`** exposes the shell clock to the
  render layer so renderer-side throttles share the deterministic timer
  seam.

Techniques evaluated and not adopted, with reasons: virtualized lists
(virtua is used only in opencode's web app, not its TUI; retention
windowing covers brewva), solid-js Transition usage (no occurrences in
opencode's TUI sources; their patch is an unrelated upstream fix),
`renderer.idle()` deferred destruction (no destructor-spike pain point in
brewva today), and per-frame sibling-margin caching (brewva's transcript
margins are static).

## Risks

- **Reconcile semantics.** WS4 changes which object identities survive across
  emits; Solid components that accidentally rely on fresh references would
  change behavior. Mitigated by the WS1 frame-snapshot lock and the existing
  interaction-event test suite.
- **Clock seam regressions.** Threading an injectable clock through
  `CliShellRuntime` touches initialization paths. Mitigated by keeping the
  default a passthrough to real timers and by the existing lifecycle tests.
- **Buffer/flush divergence.** WS2 introduces a window where the buffer is
  ahead of committed state; crash or session-switch during streaming must
  fall back to the wire-fold snapshot, which remains the source of truth.
- **Scroll behavior drift.** WS5 changes when scroll state reaches the
  domain store; overlays or commands that read `surface.scrollOffset`
  mid-stream would observe staler values. Audit readers of the surface
  slice before landing, and keep follow-mode transitions synchronous.
- **Composer external writes.** WS3's uncontrolled-while-editing contract
  must enumerate every legitimate external write source; a missed source
  silently stops updating the textarea. Covered by the interaction-event
  suite plus a WS1 invariant per source.

## Promotion Criteria

This note graduates to `docs/research/decisions/` when:

- the replay benchmark and count invariants are merged and documented in
  `test/README.md`;
- the WS1 invariants pass: bounded emit counts, single projection per delta,
  zero synchronous filesystem I/O on the keystroke path, zero scroll-sync
  commits from content growth, and no stale composer write-back;
- the replay benchmark shows per-frame cost within a 16ms budget at a
  representative streaming rate (100 tokens/sec, 50-message transcript) on a
  development machine, with before/after numbers recorded in this note;
- interactive smoke verification confirms smooth streaming, scrolling, and
  typing under a live task.
