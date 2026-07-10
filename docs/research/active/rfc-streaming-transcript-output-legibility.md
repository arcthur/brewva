# RFC: Streaming Transcript Output Legibility — Dim The Tools, Fold The Code, Converge The Blocks

## Metadata

- Status: active
- Kind: RFC (a render-layer UX increment over the shipped wire-fold transcript, not a new plane)
- Owner: CLI / TUI maintainers
- Last reviewed: `2026-07-10`
- Depends on:
  - [Design Axioms](../../architecture/design-axioms.md) (axiom 3 `Subtraction beats switches`,
    axiom 6 `Views rebuild from receipts`, axiom 12 `Product loops are projections`,
    axiom 18 `Descriptive metadata derives views, never authority`)
  - The shipped wire-fold transcript pipeline (`packages/brewva-cli/src/shell/domain/cockpit/wire-fold.ts`,
    `packages/brewva-cli/runtime/shell/transcript.tsx`) — the substrate this note re-renders, unchanged.
- Promotion target:
  - `docs/research/decisions/` (an ADR once the three pillars are dogfooded and the fold thresholds are tuned against real sessions)
  - `docs/reference/commands.md` / TUI reference (only if a user-facing view toggle is added; the default-path change needs no command)

## Problem Statement

brewva's streaming transcript is mechanically sound but visually illegible. During and after a
turn, the reader complains of three things at once:

- **(a) code appears as one giant fully-expanded chunk** — a 200-line file write or a long fenced
  block fills the viewport with no ceiling;
- **(b) too many visual blocks** — a normal `text → read → text → edit → text → exec` turn stacks
  a dozen separately-bordered, separately-margined boxes;
- **(c) the descriptive prose gets drowned** — the one or two sentences where Claude explains what
  it is doing lose all salience between the heavy tool boxes.

The mechanism is not the problem. brewva already renders assistant text through
`@opentui/core`'s streaming markdown (`<markdown streaming internalBlockMode="top-level">`,
`markdown-transcript-block.tsx:17-28`) with incremental parsing and stable-prefix reuse — the same
primitive `opencode`'s TUI uses. All three complaints are **information-architecture** defects in
the render layer, and the fix needs no new dependency: the installed `@opentui/core@0.4.2` already
ships `CodeRenderable`, `DiffRenderable`, and the markdown `renderNode` / `createMarkdownCodeBlockRenderer`
fold hooks.

### Root cause, per complaint (all verified in the current worktree)

**(a) uncapped code.** Assistant fenced code is handed to `<markdown>` as one `content` string with
**no height cap and no collapse** (`markdown-transcript-block.tsx:17-28`). `WriteToolView` echoes the
**whole file** into a `<code>` with no cap (`transcript.tsx:348-368`); `DiffToolView` renders the
**full diff** (`transcript.tsx:395-477`). Meanwhile _tool output_ IS capped — `EXEC_COLLAPSED_LINE_LIMIT = 10`,
`GENERIC_COLLAPSED_LINE_LIMIT = 5`, `COLLAPSED_LINE_CHAR_LIMIT = 2000` (`transcript.tsx:479-490`). The cap
policy is inverted: the largest payloads (code, whole files, diffs) are the ones with no ceiling.

**(b) block explosion.** Two multipliers compound. First, the wire fold **finalizes and deletes**
the live assistant text segment on **every** `tool.started` / `tool.progress` / `tool.finished`
(`wire-fold.ts:1117,1132,1147` → `finishTranscriptAssistantSegmentsForTurn`, which deletes the
segment so the next delta opens a fresh message; `updateTranscriptAssistantDelta` mints a new
`messageId` with `++#transcriptSegmentSequence`, `wire-fold.ts:656-684`). Each tool call is also its
own `role:"tool"` message. Second, each message becomes its own `transcript-row` box
(`fullscreen-app.tsx:220-243`) and every part carries a fixed `marginTop={1}` (`InlineTool`
`transcript.tsx:169`, `BlockTool` `:232`, `TextPartView` `:273`), so consecutive tool rows each pull an
empty line. Every committed assistant segment additionally repeats the `▣ Brewva · model` label
(`transcript.tsx:1011`).

**(c) drowned prose.** Visual weight is inverted. Prose (`TextPartView`, `transcript.tsx:266-282`) is
borderless, background-less plain text with only `paddingLeft={3}`. The tool boxes around it
(`BlockTool`, `transcript.tsx:205-264`) carry a `┃` left rail + `theme.backgroundPanel` fill + top/bottom
padding, and completed tools are **not dimmed** (they use `safetyToneColor`, a full-strength color, not
`theme.textMuted`). The loud boxes read as structure; the quiet narration reads as the gap between them.

### Scope boundaries

- **In scope:** the render layer under `packages/brewva-cli/runtime/shell/**` plus one pure
  view-projection helper. Dim completed tools, converge inter-block spacing, fold long code / whole-file
  writes / diffs, deduplicate the per-turn label.
- **Out of scope (this note):** any change to the wire-fold segmentation data model, the event tape,
  the transcript projector, or the four-port seam. The block-explosion **root** (segment split on every
  tool frame) is diagnosed here but deliberately left to a follow-up; this note takes the render-layer
  ("light") convergence only. See Open Questions.
- **Non-goal:** touching model-visible context. This is a human-facing view; folding a code block hides
  nothing from the model and moves no `stablePrefixHash`.

## The Design: three pillars, render-layer only

Same turn, before and after — the target hand-feel:

```
NOW                                          UPGRADED
────────────────────────────────────────    ────────────────────────────────────────
▣ Brewva · fable-5                           Let me check the retry helper first. The
Let me check the retry helper first.         backoff is linear, so I'll switch it to
┃ → Read retry.ts                            exponential.
▣ Brewva · fable-5                             → read retry.ts
The backoff is linear. I'll switch it          ← edit retry.ts · +2 −2
┃ ← Edit retry.ts                              $ bun test retry · ✓ 42 pass
┃   - const delay = base * attempt           Done — it now doubles the delay each
┃   + const delay = base * 2 ** attempt      attempt and caps at maxDelay. Final helper:
┃   - await sleep(delay)                      export function retry(fn, base, maxDelay) {
┃   + await sleep(Math.min(delay, maxDelay))    for (let a = 0; a < 6; a++) {
┃ $ bun test retry                                try { return await fn() }
┃   bun test v1.1.0                               ⋯ 5 more lines   click to expand
┃   ✓ backs off exponentially                   }
┃   ✓ caps at maxDelay                        }
┃    42 pass · 0 fail                         ▣ Brewva · fable-5
▣ Brewva · fable-5
Here's the final helper:                     (tools dim + packed into a list · prose
export function retry(...) {                   leads at full strength · long code folded
  ...9 lines, fully expanded...                to 12 lines · one label per turn)
```

The organizing move, borrowed from `opencode`'s transcript: **let the tool calls recede (dim +
single-line + packed) so the narration advances (full strength + breathing room)**, and put a ceiling
on every large payload. brewva today does the opposite.

### Pillar 1 — visual hierarchy (fixes c, half of b)

- **1a. Dim completed tools.** In `InlineTool`'s `tone` memo (`transcript.tsx:157-165`), a
  `status === "completed"` non-error tool resolves to `theme.textMuted` (today: full-strength
  `safetyToneColor`); hover restores the accent to signal it is still clickable. `BlockTool` titles
  follow. Pending/running/error tones are unchanged.
- **1b. Converge inter-block spacing by static grouping.** A new pure helper
  `groupTranscriptMessages(messages)` runs in `fullscreen-app.tsx` immediately before
  `<For each={rows()}>`. It folds a run of consecutive same-`turn` `role:"tool"` messages into one
  `tool-group` row; inside the group tool rows use `marginTop=0` (packed into a list), the group itself
  keeps `marginTop=1`. The `turnId` is read from the message id (`…:${turnId}:tool:${toolCallId}`,
  minted at `wire-fold.ts:133-138`). Group key = the first member's message id, so identity is stable
  across streaming frames.
- **1c. Prefer single-line tools.** Keep tools without a materialized payload (read/grep/glob/list)
  on `InlineTool`; only upgrade to the bordered `BlockTool` when there is real diff/exec output to show.
  This is mostly already true (`read`); the change is to hold the line rather than promote eagerly.

**Why static grouping, not `opencode`'s per-frame margin.** `opencode` collapses margins with a
per-frame `setPreLayoutSiblingMargin` (`onLifecyclePass` recomputes each sibling's `marginTop` every
layout pass, `util/layout.ts`). brewva uses an internal-`marginTop` spacing model, and a prior review
already rejected porting the per-frame hook (per-frame cost + untestable visual regression). Static
grouping is a declarative pure function — deterministic, unit-testable, no per-frame work — and it fits
brewva's structural-sharing render discipline. It reaches the same packed-list result by a cheaper route.

### Pillar 2 — fold code and long output (fixes a; information-density-first)

Default posture: **information density first.** Fold aggressively; the reader expands on demand.

- **2a. Fold long assistant code blocks — by render phase.**
  - While `renderMode === "streaming"` (the segment is still being written), the whole part renders as
    `<markdown streaming>` **unfolded** — the reader is watching it generate, matching opentui's
    "trailing block stays unstable" contract.
  - Once `renderMode === "stable"` (committed), revive the currently-dead `splitTranscriptTextBlocks`
    (`transcript-markdown.ts:20`, presently imported only by tests) to split the part into prose / code
    segments. Prose segments still go through `<markdown>`. A code segment **longer than
    `CODE_COLLAPSED_LINE_LIMIT` (~15)** renders through a new `CollapsibleCodeBlock` (`<code>` folded to
    12 lines + a muted `⋯ N more · click to expand` affordance), reusing the existing `toolRenderCache`
    to persist expand state across re-renders.
- **2b. Bring `Write` and diffs under the same cap.** `WriteToolView`'s whole-file `<code>`
  (`transcript.tsx:360-367`) and `DiffToolView`'s full diff (`transcript.tsx:419,447`) adopt the same
  fold-to-N-lines + expand affordance. The fold thresholds live as named constants beside the existing
  `EXEC_COLLAPSED_LINE_LIMIT` / `GENERIC_COLLAPSED_LINE_LIMIT` (`transcript.tsx:479-490`) so all cap policy
  is one place, ending the inversion where the largest payloads were the only uncapped ones.

### Pillar 3 — block-count convergence (light)

- **3a. Deduplicate the per-turn label.** Render `▣ Brewva · model` only on the **last committed
  assistant segment of a turn** (`AssistantMessageView`, gate at `transcript.tsx:1011`), not once per
  segment. The turn's last-segment test uses the same `turnId` id-prefix as 1b.
- **3b. Adjacent-segment convergence** is absorbed by 1b's `groupTranscriptMessages` (same-turn adjacent
  assistant segments do not pull an extra inter-block margin).

The block-explosion **root** — wire-fold splitting the assistant segment on every tool frame — is left
to a data-layer follow-up (Open Questions). Pillars 1b + 3 converge the _rendered_ result enough that
the visual symptom is largely gone without touching tape semantics.

## Data Flow And Boundary

```
wire frame → shell-runtime (16ms flush) → wire-fold (UNCHANGED) → transcript-projector (UNCHANGED)
  → messages() → [NEW] groupTranscriptMessages (pure projection) → <For rows> → render layer
                                                                    (dim · fold · group · dedupe label)
```

Everything up to `messages()` is untouched. The only additions are one pure projection at the very end
and the render-layer components that consume it. That is the boundary guarantee behind "render-layer only".

## Invariants (narrower rules on the shared projection discipline)

`groupTranscriptMessages` is a projection, so it inherits `active/README.md`'s Shared Projection
Discipline. The narrower invariants for this render projection:

- **Deterministic and rebuildable.** `groupTranscriptMessages(messages)` is a pure function of the
  message list; identical input yields identical grouping and identical group keys. It is never replay
  truth — it is a transient view derived from the already-projected transcript (axiom 6).
- **Authority-neutral.** Grouping, dimming, and folding change presentation only. No fold or group
  reads or writes kernel, capability, source, or adoption authority; no view path derives authority from
  the `turnId` it parses out of a message id (axiom 18).
- **Not model-visible.** This is a human-facing transcript render. Folding a code block or dimming a
  tool changes zero model-visible bytes and moves no `stablePrefixHash`; the discipline's "must not
  auto-push into model-visible context" holds trivially because nothing here touches context assembly.
- **Fold hides nothing destructively.** Every fold shows its hidden-line count and is one interaction
  from full text; expand state is persisted (`toolRenderCache`) so a fold is never a one-way loss.

## Surface Budget

Render-layer-only; net zero on every counted surface.

| Surface                                 | Before | After | Δ   |
| --------------------------------------- | ------ | ----- | --- |
| Required authored fields                | 0      | 0     | 0   |
| Optional authored fields                | 0      | 0     | 0   |
| Author-facing concepts                  | 0      | 0     | 0   |
| Inspect artifacts                       | 0      | 0     | 0   |
| Routing / control-plane decision points | 0      | 0     | 0   |
| Config keys                             | 0      | 0     | 0   |
| Persisted formats                       | 0      | 0     | 0   |
| Public CLI / API surfaces               | 0      | 0     | 0   |

The chosen posture (information-density-first, fixed thresholds) deliberately adds **no** config key.
Fold thresholds are internal constants; if dogfooding shows a real need for a user override, adding a
`view.*` toggle is a separate, budgeted follow-up, not part of this note.

## Source Anchors

- `packages/brewva-cli/runtime/shell/markdown-transcript-block.tsx`:17-28 — assistant markdown/code, uncapped (Pillar 2a).
- `packages/brewva-cli/runtime/shell/transcript.tsx`:157-165 — `InlineTool` tone (Pillar 1a).
- `packages/brewva-cli/runtime/shell/transcript.tsx`:205-264 — `BlockTool` border/panel/margin (Pillars 1a, 1c).
- `packages/brewva-cli/runtime/shell/transcript.tsx`:266-282 — `TextPartView` prose (complaint c).
- `packages/brewva-cli/runtime/shell/transcript.tsx`:348-368 — `WriteToolView`, whole-file echo, uncapped (Pillar 2b).
- `packages/brewva-cli/runtime/shell/transcript.tsx`:395-477 — `DiffToolView`, full diff, uncapped (Pillar 2b).
- `packages/brewva-cli/runtime/shell/transcript.tsx`:479-490 — existing collapse limits (cap-policy home).
- `packages/brewva-cli/runtime/shell/transcript.tsx`:1011 — per-segment label repeat (Pillar 3a).
- `packages/brewva-cli/runtime/shell/fullscreen-app.tsx`:220-243 — per-message row box + `<For>` (Pillar 1b).
- `packages/brewva-cli/runtime/shell/transcript-markdown.ts`:20 — dead `splitTranscriptTextBlocks` to revive (Pillar 2a).
- `packages/brewva-cli/src/shell/domain/cockpit/wire-fold.ts`:1117,1132,1147 — segment finalize on every tool frame (complaint b root).
- `packages/brewva-cli/src/shell/domain/cockpit/wire-fold.ts`:96-145 — message id builders that encode `turnId` (enables 1b/3a grouping).
- `@opentui/core@0.4.2` `renderables/Markdown.d.ts:116-118` (`createMarkdownCodeBlockRenderer`) and `renderables/Code.d.ts` (`CodeRenderable` streaming) — the fold primitives already installed.

## Validation Signals

- `groupTranscriptMessages` unit tests: `text→tool→text→tool` interleave folds tool runs but not
  prose; a turn boundary breaks a group; identical input yields identical group keys (streaming identity
  stability).
- `splitTranscriptTextBlocks` revival: add streaming-boundary cases (unterminated fence, prose/code
  alternation) on top of its existing whole-text tests.
- `CollapsibleCodeBlock` fold/expand: threshold boundary (14 / 15 / 16 lines), hidden-line-count text,
  expand-state persistence across a re-render.
- Full gates green per repo policy: `bun run check` + full `bun test` + `test:tui` + `test:dist`.
- Dogfood signal: a real interleaved `text/tool` turn reads as narration-led with tools as a dim packed
  list, long code folded, one label per turn — the before/after hand-feel above, observed live.

## Landing Plan

Each pillar lands and verifies independently, lowest risk first.

1. **Pillar 1a + 1c** (dim completed tools, hold single-line). Pure color/branch change in
   `transcript.tsx`; smallest blast radius.
2. **Pillar 1b + 3a** (`groupTranscriptMessages` + label dedupe). New pure helper + `fullscreen-app.tsx`
   row projection; unit-tested; watch group-key identity under streaming.
3. **Pillar 2** (fold code / write / diff, revive `splitTranscriptTextBlocks`, `CollapsibleCodeBlock`).
   Highest risk (streaming→stable reflow, fence handling); phase-gated on 1/2 being green.

## Implementation Notes (As Built, 2026-07-10)

All three pillars landed on this branch, render-layer only, with per-step independent review and
the full gate green (`check`; `test:unit` 2796; `test:fitness` 455; `test:tui` 33; `test:dist`).
Two deliberate refinements to the design above, and one deferral:

- **1a scope narrowed to `InlineTool`.** Only completed single-line `InlineTool` rows dim to
  `textMuted`; `BlockTool` titles stay full strength (the design said "BlockTool titles follow"). A
  `BlockTool` carries the diff/exec output the reader actually wants, so dimming its title would
  recede the very content it exists to show. Tone lives in the pure `resolveInlineToolTone`
  (`tool-tone.ts`).
- **1b is a hint map, not a grouped-row structure.** The design's `groupTranscriptMessages` →
  tool-group rows would have keyed the transcript's `<For>` on freshly-built row objects, rebuilding
  every row every streaming frame (a real perf regression caught in review). The as-built
  `projectTranscriptRowHints(messages)` (`transcript-rows.ts`) returns a
  `Map<id, {compactTop, showAssistantLabel}>` and `<For each={messages()}>` keeps keying on the
  structurally-shared message refs — zero per-frame rebuild. Packing is achieved by `compactTop`
  alone (a zero top margin on a packed `InlineTool`) delivered through a reactive accessor context
  (`transcript-row-spacing.ts`); no wrapper box is needed. The projection reads only `role`, `id`,
  and (for the packing guard below) the previous tool's `toolName` — never `parts[].text`. It
  recomputes per store flush, but each pass is O(n) `indexOf`/Map work that rebuilds no rows, so the
  load-bearing guarantee (no per-frame DOM rebuild while streaming) holds.
- **2 folds Write and assistant code; diff folding is deferred.** `collapseCodeContent` +
  `splitFoldableCodeBlocks` (`code-fold.ts`) fold whole-file writes and long committed assistant
  fenced code to `CODE_COLLAPSED_LINE_LIMIT` (16) lines with a `maxLineWidth` char cap (2000, the
  exec/generic guard). Assistant code splits only at `stable` render mode (streaming stays one live
  `<markdown>`), and lifts a block only when it will actually fold (body `> limit`). **Diff folding
  (2b for `DiffToolView`) is a follow-up:** `DiffView` renders through opentui's `DiffRenderable`,
  and truncating the diff string would corrupt hunk parsing — folding it needs a render-height
  mechanism, not a line slice, and Write (the highest-frequency "giant code" source) plus assistant
  code already cover the complaint.

### Review-round refinements (whole-change audit + opencode-comparison)

Two independent reviews (a whole-change pipeline audit and an opencode-technique comparison) both
returned SHIP; their actionable findings landed:

- **Packing guarded to guaranteed-inline previous tools** (from opencode's height-aware margin). A
  role-only static projection cannot see that the previous tool rendered as a bordered multi-line
  block, so an `exec → read` run packed the Read flush against the block's bottom edge.
  `projectTranscriptRowHints` now packs only when the previous tool's `toolName` is in a
  guaranteed-single-line allowlist (`read` today; `ReadToolView` is unconditionally inline). An
  allowlist — not a denylist of block tools — because `GenericToolView` also renders a block for
  errored / details-mode / subagent / MCP / custom tools whose names are open-ended and could never
  be enumerated; under-packing anything not known-inline is the safe direction (a spare blank line,
  never an inline row flush under a block). opencode's per-frame height check was deliberately not
  ported.
- **Reasoning collapses to a title** (from opencode's collapse-by-default thinking). Committed
  reasoning was the largest un-folded vertical consumer — inconsistent with folding code. Stable
  reasoning now collapses to a `▸ Thought: <title>` line (title via the pure `summarizeReasoning`,
  `reasoning-summary.ts`) with click-to-expand, staying fully visible while it streams.
- **De-duplicated the line-width cap.** `capCollapsedLine` and `capLineWidth` were the same
  slice+ellipsis; consolidated onto the exported `capLineWidth` (`code-fold.ts`).

Deferred from the reviews (recorded, not lost): the external `$PAGER` transcript export renders
un-deduped labels and inert fold hints (folding-in-pager is pre-existing — exec/generic already fold
there); a running-vs-pending tool distinction and denied-tool strikethrough (brewva's safety model
carries no `denied` tone, so this needs a model addition, not an opencode-style substring hack); an
animated spinner and duration/tokens on the `▣` byline (the latter crosses the frozen projection
seam). `splitTranscriptTextBlocks` was NOT revived as this note first planned — its section-header
splitting fragments prose; the new `splitFoldableCodeBlocks` lifts only long fenced code and leaves
the old helper dead.

Landed files: `tool-tone.ts`, `transcript-rows.ts`, `transcript-row-spacing.ts`, `code-fold.ts`,
`reasoning-summary.ts` (each with a unit test), plus edits to `transcript.tsx` and `fullscreen-app.tsx`.

## Open Questions / Risks

- **Streaming→stable reflow.** Splitting into fold blocks at `stable` produces one visual jump when a
  code block turns from inline markdown into a folded block. Mitigation: split only at `stable`, so the
  jump lands at turn close (opencode's committed rebuild has a comparable reflow); if jarring, fall back
  to folding inside `<markdown>` via `renderNode` (imperative, harder to make expand-state reactive).
- **Group identity churn.** If the group key is not stable, streaming re-renders would churn the `<For>`.
  Mitigation: key on the first member's message id; unit-test guards it. (Memory flags transcript-projector
  identity as a known trap.)
- **Density hiding wanted code.** Aggressive default fold may hide code the reader wanted. Mitigation:
  explicit hidden-line count + one-key expand + persisted expand state; revisit thresholds against real
  sessions before promotion.
- **The block-explosion root is deferred.** Pillars 1b/3 converge the symptom in the render layer but do
  not stop wire-fold from minting a new segment per tool frame. A future data-layer note may reshape
  segmentation so a turn's text/tool parts coexist in one message's `parts` sequence (the `opencode`
  shape), from the root — but that mutates tape projection and must preserve replay/committed equivalence
  and identity, so it is out of scope here by design.

## Promotion Criteria And Destination Docs

- All three pillars landed on `main` with the full gate green, and the before/after hand-feel confirmed
  by live dogfooding on a real interleaved turn.
- Fold thresholds tuned against ≥1 corpus of real sessions (density-first defaults validated as helpful,
  not hiding wanted content).
- On satisfaction, convert to `docs/research/decisions/` (an ADR for the transcript legibility contract);
  if a user-facing view toggle was added, document it in the TUI command/keymap reference. Until then this
  stays an active render-layer note owning provenance only.
